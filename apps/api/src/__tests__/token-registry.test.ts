import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';
import {
  InMemoryTokenRegistry,
  loadTokenRecords,
  hashToken,
  type TokenRecord,
} from '../auth/token-registry.js';

describe('InMemoryTokenRegistry', () => {
  const records: TokenRecord[] = [
    { token: 'jeremy-token', actor: 'jeremy', role: 'admin' },
    { token: 'pablo-token', actor: 'pablo', role: 'member' },
  ];

  it('resolves a known token to its identity', () => {
    const reg = new InMemoryTokenRegistry(records);
    expect(reg.resolve('jeremy-token')).toEqual({ actor: 'jeremy', role: 'admin' });
    expect(reg.resolve('pablo-token')).toEqual({ actor: 'pablo', role: 'member' });
  });

  it('returns undefined for an unknown token', () => {
    const reg = new InMemoryTokenRegistry(records);
    expect(reg.resolve('nope')).toBeUndefined();
  });

  it('revocation = dropping the record (the dropped token no longer resolves)', () => {
    const afterRevoke = records.filter((r) => r.actor !== 'pablo');
    const reg = new InMemoryTokenRegistry(afterRevoke);
    expect(reg.resolve('jeremy-token')).toEqual({ actor: 'jeremy', role: 'admin' });
    expect(reg.resolve('pablo-token')).toBeUndefined(); // revoked
  });

  it('reports empty', () => {
    expect(new InMemoryTokenRegistry([]).isEmpty()).toBe(true);
    expect(new InMemoryTokenRegistry(records).isEmpty()).toBe(false);
  });

  // ---- tenant binding (EPIC 0, compile-then-govern-c5k) -------------------

  it('surfaces the tenant allowlist for a scoped token', () => {
    const reg = new InMemoryTokenRegistry([
      { token: 'scoped', actor: 'a', role: 'admin', tenants: ['team-alpha'] },
    ]);
    expect(reg.resolve('scoped')).toEqual({
      actor: 'a',
      role: 'admin',
      tenants: ['team-alpha'],
    });
  });

  it('omits `tenants` for an unscoped token (back-compat shape)', () => {
    const reg = new InMemoryTokenRegistry([{ token: 'open', actor: 'a', role: 'admin' }]);
    const id = reg.resolve('open');
    expect(id).toEqual({ actor: 'a', role: 'admin' });
    expect(id && 'tenants' in id).toBe(false);
  });

  // ---- hashing at rest (EPIC 0, compile-then-govern-c5k) ------------------

  it('hashToken emits a salted scrypt hash, never the plaintext', () => {
    const h = hashToken('super-secret');
    expect(h).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(h).not.toContain('super-secret');
  });

  it('hashToken salts per call — same secret hashes to different values', () => {
    expect(hashToken('same')).not.toBe(hashToken('same'));
  });

  it('does NOT retain the plaintext token anywhere in the registry instance', () => {
    const reg = new InMemoryTokenRegistry([
      { token: 'plaintext-leak-canary', actor: 'a', role: 'admin' },
    ]);
    // A full structural walk of the instance must not surface the secret.
    expect(JSON.stringify(reg)).not.toContain('plaintext-leak-canary');
    // ...but the secret still resolves (we compare via the stored hash).
    expect(reg.resolve('plaintext-leak-canary')).toEqual({ actor: 'a', role: 'admin' });
  });

  // ---- expiry (EPIC 0, compile-then-govern-c5k) --------------------------

  it('resolves a not-yet-expired token', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const reg = new InMemoryTokenRegistry([
      { token: 'fresh', actor: 'a', role: 'admin', expiresAt: future },
    ]);
    expect(reg.resolve('fresh')).toEqual({ actor: 'a', role: 'admin' });
  });

  it('refuses an expired token (fails closed past expiresAt)', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    // Construct the registry directly (loadTokenRecords drops past-expiry at
    // load; here we prove resolve() itself enforces the instant).
    const reg = new InMemoryTokenRegistry([
      { token: 'stale', actor: 'a', role: 'admin', expiresAt: past },
    ]);
    expect(reg.resolve('stale')).toBeUndefined();
  });

  // ---- live revocation (EPIC 0, compile-then-govern-c5k) -----------------

  it('live-revokes a token without a restart (resolve stops returning it)', () => {
    const reg = new InMemoryTokenRegistry([
      { token: 'live', actor: 'a', role: 'admin' },
      { token: 'other', actor: 'b', role: 'member' },
    ]);
    expect(reg.resolve('live')).toEqual({ actor: 'a', role: 'admin' });
    expect(reg.revoke('live')).toBe(true);
    expect(reg.resolve('live')).toBeUndefined(); // cut off, no restart
    expect(reg.resolve('other')).toEqual({ actor: 'b', role: 'member' }); // others intact
  });

  it('revoke returns false for a token that does not match any record', () => {
    const reg = new InMemoryTokenRegistry([{ token: 'live', actor: 'a', role: 'admin' }]);
    expect(reg.revoke('never-existed')).toBe(false);
  });
});

describe('loadTokenRecords', () => {
  it('promotes a single apiKey to one admin token (actor "shared")', () => {
    expect(loadTokenRecords({ apiKey: 'k' })).toEqual([
      { token: 'k', actor: 'shared', role: 'admin' },
    ]);
  });

  it('parses TEAMKB_TOKENS json (records win over apiKey)', () => {
    const json = JSON.stringify([{ token: 't1', actor: 'a', role: 'admin' }]);
    expect(loadTokenRecords({ apiKey: 'k', tokensJson: json })).toEqual([
      { token: 't1', actor: 'a', role: 'admin' },
    ]);
  });

  it('defaults a missing/invalid role to least-privileged member', () => {
    const json = JSON.stringify([{ token: 't', actor: 'a' }]);
    expect(loadTokenRecords({ tokensJson: json })[0]!.role).toBe('member');
  });

  it('skips malformed entries (no silent grant from a bad file)', () => {
    const json = JSON.stringify([
      { actor: 'no-token' },
      { token: 'ok', actor: 'a', role: 'member' },
    ]);
    const out = loadTokenRecords({ tokensJson: json });
    expect(out).toHaveLength(1);
    expect(out[0]!.token).toBe('ok');
  });

  it('reads from a tokens file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamkb-tokens-'));
    try {
      const file = join(dir, 'tokens.json');
      writeFileSync(file, JSON.stringify([{ token: 'ft', actor: 'fa', role: 'admin' }]));
      expect(loadTokenRecords({ tokensFile: file })).toEqual([
        { token: 'ft', actor: 'fa', role: 'admin' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty when nothing is configured', () => {
    expect(loadTokenRecords({})).toEqual([]);
  });

  // ---- tenant allowlist parsing (EPIC 0, compile-then-govern-c5k) ---------

  it('parses a tenants allowlist from a token record', () => {
    const json = JSON.stringify([
      { token: 't', actor: 'a', role: 'admin', tenants: ['team-alpha', 'team-beta'] },
    ]);
    expect(loadTokenRecords({ tokensJson: json })).toEqual([
      { token: 't', actor: 'a', role: 'admin', tenants: ['team-alpha', 'team-beta'] },
    ]);
  });

  it('omits tenants when the field is absent (unscoped token)', () => {
    const json = JSON.stringify([{ token: 't', actor: 'a', role: 'admin' }]);
    const out = loadTokenRecords({ tokensJson: json });
    expect(out[0]).toEqual({ token: 't', actor: 'a', role: 'admin' });
    expect(out[0] && 'tenants' in out[0]).toBe(false);
  });

  it('treats an empty / malformed tenants array as unscoped (never widens to all)', () => {
    const json = JSON.stringify([
      { token: 'empty', actor: 'a', role: 'admin', tenants: [] },
      { token: 'bad', actor: 'b', role: 'admin', tenants: [123, ''] },
    ]);
    const out = loadTokenRecords({ tokensJson: json });
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.tenants === undefined)).toBe(true);
  });

  // ---- expiry parsing (EPIC 0, compile-then-govern-c5k) ------------------

  it('keeps a future expiresAt on the record', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const json = JSON.stringify([{ token: 't', actor: 'a', role: 'admin', expiresAt: future }]);
    expect(loadTokenRecords({ tokensJson: json })[0]!.expiresAt).toBe(future);
  });

  it('drops an already-expired record at load (never grants briefly)', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const json = JSON.stringify([
      { token: 'gone', actor: 'a', role: 'admin', expiresAt: past },
      { token: 'ok', actor: 'b', role: 'admin' },
    ]);
    const out = loadTokenRecords({ tokensJson: json });
    expect(out).toHaveLength(1);
    expect(out[0]!.token).toBe('ok');
  });

  it('drops a record with a malformed expiresAt (fail closed, not forever-token)', () => {
    const json = JSON.stringify([
      { token: 'typo', actor: 'a', role: 'admin', expiresAt: 'not-a-date' },
    ]);
    expect(loadTokenRecords({ tokensJson: json })).toHaveLength(0);
  });
});

describe('per-user tokens through buildApp', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDatabase();
    app = buildApp({
      db,
      silent: true,
      tokens: [
        { token: 'jeremy-token', actor: 'jeremy', role: 'admin' },
        { token: 'pablo-token', actor: 'pablo', role: 'member' },
      ],
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('accepts each valid per-user token', async () => {
    for (const tok of ['jeremy-token', 'pablo-token']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memories',
        headers: { Authorization: `Bearer ${tok}` },
      });
      expect(res.statusCode).not.toBe(401);
    }
  });

  it('rejects an unknown/revoked token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories',
      headers: { Authorization: 'Bearer revoked-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('keeps /api/health exempt under per-user auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });
});
