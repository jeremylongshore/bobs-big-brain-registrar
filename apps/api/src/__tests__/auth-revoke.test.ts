import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';

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
