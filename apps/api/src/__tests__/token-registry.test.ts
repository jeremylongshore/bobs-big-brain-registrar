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
