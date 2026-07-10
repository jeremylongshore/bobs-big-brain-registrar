import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
  buildTokenRegistry,
  loadRevokedActors,
  appendRevokedActor,
  type TokenRecord,
  type RevokedActorEntry,
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

  // ---- pre-hashed at-rest tokens (E1 — no plaintext bearer secret on disk) --

  it('accepts an already-hashed `scrypt$salt$hash` token and resolves the plaintext', () => {
    // The on-disk record stores hashToken(secret) — NOT the secret. The holder
    // still presents the plaintext; it verifies against the stored salt+hash.
    const stored = hashToken('member-secret');
    expect(stored).not.toContain('member-secret'); // nothing plaintext at rest
    const reg = new InMemoryTokenRegistry([{ token: stored, actor: 'ezekiel', role: 'member' }]);
    expect(reg.resolve('member-secret')).toEqual({ actor: 'ezekiel', role: 'member' });
    expect(reg.resolve('wrong-secret')).toBeUndefined();
    expect(reg.resolve(stored)).toBeUndefined(); // the hash itself is not a valid bearer token
  });

  it('mixes pre-hashed and plaintext records in one registry (both resolve)', () => {
    const reg = new InMemoryTokenRegistry([
      { token: hashToken('hashed-secret'), actor: 'tim', role: 'member' },
      { token: 'plain-secret', actor: 'jeremy', role: 'admin' },
    ]);
    expect(reg.resolve('hashed-secret')).toEqual({ actor: 'tim', role: 'member' });
    expect(reg.resolve('plain-secret')).toEqual({ actor: 'jeremy', role: 'admin' });
  });

  it('preserves tenant + expiry on a pre-hashed record', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const reg = new InMemoryTokenRegistry([
      {
        token: hashToken('scoped-secret'),
        actor: 'a',
        role: 'admin',
        tenants: ['t1'],
        expiresAt: future,
      },
    ]);
    expect(reg.resolve('scoped-secret')).toEqual({ actor: 'a', role: 'admin', tenants: ['t1'] });
  });

  it('treats a plaintext token that merely looks like `scrypt$...` as plaintext (fail-safe)', () => {
    // Non-hex segments make it an invalid stored hash, so it is hashed as a
    // plaintext secret rather than mistaken for a valid at-rest hash.
    const looksHashed = 'scrypt$not-hex$also-not-hex';
    const reg = new InMemoryTokenRegistry([{ token: looksHashed, actor: 'a', role: 'admin' }]);
    expect(reg.resolve(looksHashed)).toEqual({ actor: 'a', role: 'admin' });
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

  // ---- revoke-by-actor (durable incident response — jfv.6.2) --------------

  it('revokeByActor revokes ALL of one actor’s records and returns the count', () => {
    // Tim carries two tokens (laptop + workstation); revoking the identity must
    // cut off both at once and report the count.
    const reg = new InMemoryTokenRegistry([
      { token: 'tim-laptop', actor: 'tim', role: 'member' },
      { token: 'tim-workstation', actor: 'tim', role: 'member' },
      { token: 'other', actor: 'jeremy', role: 'admin' },
    ]);
    expect(reg.revokeByActor('tim')).toBe(2);
    // Both of Tim's tokens are dead; the other actor is untouched.
    expect(reg.resolve('tim-laptop')).toBeUndefined();
    expect(reg.resolve('tim-workstation')).toBeUndefined();
    expect(reg.resolve('other')).toEqual({ actor: 'jeremy', role: 'admin' });
  });

  it('a revoked actor does NOT resolve after revokeByActor', () => {
    const reg = new InMemoryTokenRegistry([{ token: 'tim-token', actor: 'tim', role: 'member' }]);
    expect(reg.resolve('tim-token')).toEqual({ actor: 'tim', role: 'member' });
    reg.revokeByActor('tim');
    expect(reg.resolve('tim-token')).toBeUndefined();
  });

  it('revokeByActor returns 0 for an unknown actor (still safe, no throw)', () => {
    const reg = new InMemoryTokenRegistry([{ token: 'live', actor: 'jeremy', role: 'admin' }]);
    expect(reg.revokeByActor('nobody')).toBe(0);
    expect(reg.resolve('live')).toEqual({ actor: 'jeremy', role: 'admin' });
  });

  it('applies a boot-time revoked-actors list at construction (survives restart)', () => {
    // Simulate a restart: the same records reload, but the actor is on the
    // durable revocation list, so their token starts life revoked.
    const reg = new InMemoryTokenRegistry(
      [
        { token: 'tim-token', actor: 'tim', role: 'member' },
        { token: 'jeremy-token', actor: 'jeremy', role: 'admin' },
      ],
      ['tim'],
    );
    expect(reg.resolve('tim-token')).toBeUndefined(); // banned at boot
    expect(reg.resolve('jeremy-token')).toEqual({ actor: 'jeremy', role: 'admin' });
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

describe('durable revocation list (revoke-by-actor persistence — jfv.6.2)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'teamkb-revoked-'));
    file = join(dir, 'revoked-actors.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadRevokedActors returns [] for an undefined path or a missing file', () => {
    expect(loadRevokedActors(undefined)).toEqual([]);
    expect(loadRevokedActors(file)).toEqual([]); // file not created yet
  });

  it('loadRevokedActors reads the distinct set of revoked actors', () => {
    const entries: RevokedActorEntry[] = [
      { actor: 'tim', revokedAt: '2026-07-09T00:00:00.000Z', reason: 'laptop stolen' },
      { actor: 'tim', revokedAt: '2026-07-09T01:00:00.000Z' }, // duplicate → collapsed
      { actor: 'ope', revokedAt: '2026-07-09T02:00:00.000Z' },
    ];
    writeFileSync(file, JSON.stringify(entries));
    expect(loadRevokedActors(file).sort()).toEqual(['ope', 'tim']);
  });

  it('loadRevokedActors fails OPEN on an unparseable file (returns [], does not throw)', () => {
    writeFileSync(file, 'this is not json{');
    expect(loadRevokedActors(file)).toEqual([]);
  });

  it('appendRevokedActor writes an entry (append-only) and is readable back', () => {
    const first = appendRevokedActor(file, 'tim', 'laptop stolen');
    expect(first.actor).toBe('tim');
    expect(first.reason).toBe('laptop stolen');
    expect(typeof first.revokedAt).toBe('string');

    // A second append keeps the first (append-only), not overwrites it.
    appendRevokedActor(file, 'ope');
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as RevokedActorEntry[];
    expect(onDisk).toHaveLength(2);
    expect(onDisk.map((e) => e.actor)).toEqual(['tim', 'ope']);
    expect(loadRevokedActors(file).sort()).toEqual(['ope', 'tim']);
  });

  it('appendRevokedActor heals a corrupt existing file forward (does not lose the new revoke)', () => {
    writeFileSync(file, 'garbage-not-json');
    appendRevokedActor(file, 'tim');
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as RevokedActorEntry[];
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.actor).toBe('tim');
  });

  it('buildTokenRegistry applies a persisted revocation at boot (the R2 restart guarantee)', () => {
    // Persist a ban, then build a fresh registry pointed at that file — exactly
    // what happens on a service restart. The banned actor's token must NOT
    // resolve; an unbanned actor's token must.
    appendRevokedActor(file, 'tim', 'laptop stolen');
    const reg = buildTokenRegistry({
      records: [
        { token: 'tim-token', actor: 'tim', role: 'member' },
        { token: 'jeremy-token', actor: 'jeremy', role: 'admin' },
      ],
      revokedFile: file,
    });
    expect(reg.resolve('tim-token')).toBeUndefined();
    expect(reg.resolve('jeremy-token')).toEqual({ actor: 'jeremy', role: 'admin' });
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
