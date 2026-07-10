import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';
import type { RevokedActorEntry } from '../auth/token-registry.js';

/**
 * Live token revocation — POST /api/auth/revoke (EPIC 0, compile-then-govern-c5k).
 *
 * The point of this endpoint is incident response without a restart: a leaked
 * token can be cut off in-process the moment it is detected. The tests prove
 * three things: (1) an admin can revoke a token and the very next request with
 * that token is rejected; (2) revocation is admin-only (the write gate covers
 * /api/auth); (3) a malformed body is a 400, not a silent no-op.
 */
describe('live token revocation — POST /api/auth/revoke', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  const ADMIN = 'admin-token-abc';
  const MEMBER = 'member-token-xyz';
  const VICTIM = 'leaked-token-to-revoke';

  beforeEach(async () => {
    db = createTestDatabase();
    app = buildApp({
      db,
      silent: true,
      tokens: [
        { token: ADMIN, actor: 'jeremy', role: 'admin' },
        { token: MEMBER, actor: 'pablo', role: 'member' },
        { token: VICTIM, actor: 'leaked', role: 'member' },
      ],
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function revoke(actorToken: string, tokenToRevoke: unknown) {
    return app.inject({
      method: 'POST',
      url: '/api/auth/revoke',
      headers: { Authorization: `Bearer ${actorToken}` },
      payload: { token: tokenToRevoke },
    });
  }

  it('an admin revokes a token live — the next request with it is 401', async () => {
    // The victim token works before revocation.
    const before = await app.inject({
      method: 'GET',
      url: '/api/memories?tenantId=team-alpha',
      headers: { Authorization: `Bearer ${VICTIM}` },
    });
    expect(before.statusCode).not.toBe(401);

    // Admin revokes it — no restart.
    const res = await revoke(ADMIN, VICTIM);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: true });

    // The very next request with the revoked token is rejected.
    const after = await app.inject({
      method: 'GET',
      url: '/api/memories?tenantId=team-alpha',
      headers: { Authorization: `Bearer ${VICTIM}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('revocation is admin-only — a member is blocked with 403', async () => {
    const res = await revoke(MEMBER, VICTIM);
    expect(res.statusCode).toBe(403);
    // The victim token must still work (the member never revoked anything).
    const stillWorks = await app.inject({
      method: 'GET',
      url: '/api/memories?tenantId=team-alpha',
      headers: { Authorization: `Bearer ${VICTIM}` },
    });
    expect(stillWorks.statusCode).not.toBe(401);
  });

  it('revoking an unknown token returns { revoked: false }', async () => {
    const res = await revoke(ADMIN, 'never-existed');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: false });
  });

  it('a missing / non-string token body is a 400', async () => {
    const res = await revoke(ADMIN, undefined);
    expect(res.statusCode).toBe(400);
  });

  it('revocation requires authentication (no token → 401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/revoke',
      payload: { token: VICTIM },
    });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * Durable revoke-by-actor — POST /api/auth/revoke-actor (R2 review gate, jfv.6.2).
 *
 * The realistic incident after E1 hashed tokens at rest: an admin holds NO
 * plaintext bearer secret, so revoke-by-value is impossible ("Tim's laptop was
 * stolen"). Revoke-by-actor needs only the audit identity, cuts off ALL of that
 * actor's tokens, and persists the ban to a durable file so it survives a
 * restart. The tests prove: (1) an admin revokes all of an actor's tokens and
 * gets the count, and those tokens are then 401; (2) it is admin-only (write
 * gate covers /api/auth); (3) an unknown actor is 0-but-200; (4) the ban is
 * written to the durable file; (5) a fresh boot pointed at that file keeps the
 * actor revoked.
 */
describe('durable revoke-by-actor — POST /api/auth/revoke-actor', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let dir: string;
  let revokedFile: string;

  const ADMIN = 'admin-token-abc';
  const MEMBER = 'member-token-xyz';
  // Tim carries two tokens; revoking the identity must kill both.
  const TIM_A = 'tim-laptop-token';
  const TIM_B = 'tim-desktop-token';

  const TOKENS = [
    { token: ADMIN, actor: 'jeremy', role: 'admin' as const },
    { token: MEMBER, actor: 'pablo', role: 'member' as const },
    { token: TIM_A, actor: 'tim', role: 'member' as const },
    { token: TIM_B, actor: 'tim', role: 'member' as const },
  ];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'teamkb-revoke-actor-'));
    revokedFile = join(dir, 'revoked-actors.json');
    db = createTestDatabase();
    app = buildApp({ db, silent: true, tokens: TOKENS, revokedFile });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function revokeActor(actorToken: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/auth/revoke-actor',
      headers: { Authorization: `Bearer ${actorToken}` },
      payload: body,
    });
  }

  function reads(token: string) {
    return app.inject({
      method: 'GET',
      url: '/api/memories?tenantId=team-alpha',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it('an admin revokes ALL of an actor’s tokens — returns the count, both are then 401', async () => {
    // Both of Tim's tokens work before revocation.
    expect((await reads(TIM_A)).statusCode).not.toBe(401);
    expect((await reads(TIM_B)).statusCode).not.toBe(401);

    const res = await revokeActor(ADMIN, { actor: 'tim', reason: 'laptop stolen' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 2 });

    // Both tokens are cut off immediately, no restart.
    expect((await reads(TIM_A)).statusCode).toBe(401);
    expect((await reads(TIM_B)).statusCode).toBe(401);
    // Other actors are untouched.
    expect((await reads(MEMBER)).statusCode).not.toBe(401);
  });

  it('persists the ban to the durable revocation file (survives a restart)', async () => {
    await revokeActor(ADMIN, { actor: 'tim', reason: 'laptop stolen' });
    expect(existsSync(revokedFile)).toBe(true);
    const onDisk = JSON.parse(readFileSync(revokedFile, 'utf8')) as RevokedActorEntry[];
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.actor).toBe('tim');
    expect(onDisk[0]!.reason).toBe('laptop stolen');
    expect(typeof onDisk[0]!.revokedAt).toBe('string');

    // A fresh app pointed at the same file (a restart) keeps Tim revoked.
    const db2 = createTestDatabase();
    const app2 = buildApp({ db: db2, silent: true, tokens: TOKENS, revokedFile });
    await app2.ready();
    try {
      const after = await app2.inject({
        method: 'GET',
        url: '/api/memories?tenantId=team-alpha',
        headers: { Authorization: `Bearer ${TIM_A}` },
      });
      expect(after.statusCode).toBe(401);
      // A non-revoked actor still works after the "restart".
      const ok = await app2.inject({
        method: 'GET',
        url: '/api/memories?tenantId=team-alpha',
        headers: { Authorization: `Bearer ${MEMBER}` },
      });
      expect(ok.statusCode).not.toBe(401);
    } finally {
      await app2.close();
      db2.close();
    }
  });

  it('revoke-by-actor is admin-only — a member is blocked with 403', async () => {
    const res = await revokeActor(MEMBER, { actor: 'tim' });
    expect(res.statusCode).toBe(403);
    // Nothing was revoked and nothing was persisted.
    expect((await reads(TIM_A)).statusCode).not.toBe(401);
    expect(existsSync(revokedFile)).toBe(false);
  });

  it('revoking an unknown actor returns { revoked: 0 } and still 200', async () => {
    const res = await revokeActor(ADMIN, { actor: 'nobody' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 0 });
  });

  it('a missing / non-string actor body is a 400', async () => {
    expect((await revokeActor(ADMIN, {})).statusCode).toBe(400);
    expect((await revokeActor(ADMIN, { actor: 123 })).statusCode).toBe(400);
  });

  it('revoke-by-actor requires authentication (no token → 401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/revoke-actor',
      payload: { actor: 'tim' },
    });
    expect(res.statusCode).toBe(401);
  });
});
