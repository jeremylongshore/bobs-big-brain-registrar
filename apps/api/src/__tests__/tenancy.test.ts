import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  MemoryRepository,
  CandidateRepository,
} from '@qmd-team-intent-kb/store';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { buildApp } from '../app.js';
import { makeMemory, makeCandidate } from './fixtures.js';

/**
 * EPIC 0 hardening — tenant isolation bound to the TOKEN, not the request
 * (compile-then-govern-c5k).
 *
 * Before this change the `tenantId` was caller-controlled: any valid bearer
 * token could read or write any tenant's data simply by naming a different
 * tenant in the request body / query. These tests prove the binding is enforced
 * server-side:
 *
 *  - a token scoped to tenant A cannot read/write tenant B (403),
 *  - the raw pre-governance candidate inbox is admin-only,
 *  - cross-tenant single-record reads return 404 (no enumeration disclosure),
 *  - an UNSCOPED token (the single-tenant team default) is unrestricted —
 *    so the binding mechanism exists without forcing multi-tenant config.
 */
describe('tenant isolation — token→tenant binding', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let memoryRepo: MemoryRepository;
  let candidateRepo: CandidateRepository;

  // Tokens scoped to a single tenant each.
  const ALPHA_ADMIN = 'alpha-admin-token';
  const ALPHA_MEMBER = 'alpha-member-token';
  const BETA_ADMIN = 'beta-admin-token';
  // A token scoped to MORE THAN ONE tenant — the server cannot guess which one
  // an omitted tenantId means, so it must demand an explicit pick (400).
  const MULTI_ADMIN = 'multi-admin-token';
  // An unscoped admin token — no tenant allowlist (the single-tenant default).
  const UNSCOPED_ADMIN = 'root-admin-token';

  beforeEach(async () => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    candidateRepo = new CandidateRepository(db);
    app = buildApp({
      db,
      silent: true,
      tokens: [
        { token: ALPHA_ADMIN, actor: 'alice', role: 'admin', tenants: ['team-alpha'] },
        { token: ALPHA_MEMBER, actor: 'amy', role: 'member', tenants: ['team-alpha'] },
        { token: BETA_ADMIN, actor: 'bob', role: 'admin', tenants: ['team-beta'] },
        {
          token: MULTI_ADMIN,
          actor: 'mallory',
          role: 'admin',
          tenants: ['team-alpha', 'team-beta'],
        },
        { token: UNSCOPED_ADMIN, actor: 'root', role: 'admin' },
      ],
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  // ---- LIST reads are bound to the token's tenant -------------------------

  it('blocks a token from LISTING another tenant via the query param (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories?tenantId=team-beta',
      headers: auth(ALPHA_ADMIN),
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows a token to LIST its own tenant', async () => {
    memoryRepo.insert(makeMemory({ tenantId: 'team-alpha' }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories?tenantId=team-alpha',
      headers: auth(ALPHA_ADMIN),
    });
    expect(res.statusCode).toBe(200);
  });

  it('a single-tenant token that OMITS ?tenantId on LIST sees only its own tenant, not all (c5k.2)', async () => {
    memoryRepo.insert(makeMemory({ tenantId: 'team-alpha' }));
    memoryRepo.insert(makeMemory({ tenantId: 'team-beta' }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories', // tenantId OMITTED — guard must inject team-alpha
      headers: auth(ALPHA_ADMIN),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ tenantId: string }>;
    // Only the alpha row — the beta row must never appear.
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.tenantId === 'team-alpha')).toBe(true);
  });

  it('a MULTI-tenant token that OMITS ?tenantId on LIST is rejected (400)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories',
      headers: auth(MULTI_ADMIN),
    });
    expect(res.statusCode).toBe(400);
  });

  it('blocks LISTING the candidate inbox of another tenant (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/candidates?tenantId=team-beta',
      headers: auth(ALPHA_ADMIN),
    });
    expect(res.statusCode).toBe(403);
  });

  // ---- WRITE (intake) tenantId is bound to the token ----------------------

  it('blocks intaking a candidate under another tenant (403)', async () => {
    const body = makeCandidate({ tenantId: 'team-beta' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/candidates',
      headers: auth(ALPHA_ADMIN),
      payload: body,
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows intaking a candidate under the token’s own tenant', async () => {
    const body = makeCandidate({ tenantId: 'team-alpha' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/candidates',
      headers: auth(ALPHA_ADMIN),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
  });

  it('blocks promoting a candidate into another tenant (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/candidates/any-id/promote?tenantId=team-beta',
      headers: auth(ALPHA_ADMIN),
    });
    expect(res.statusCode).toBe(403);
  });

  // ---- SEARCH tenantId is bound to the token ------------------------------

  it('blocks searching another tenant via the body tenantId (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: auth(ALPHA_ADMIN),
      payload: { query: 'x', scope: 'curated', tenantId: 'team-beta' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows searching the token’s own tenant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: auth(ALPHA_ADMIN),
      payload: { query: 'x', scope: 'curated', tenantId: 'team-alpha' },
    });
    expect(res.statusCode).toBe(200);
  });

  // ---- OMITTED tenantId must NOT fall through to an all-tenant query (c5k.2) -
  //
  // The core leak: SearchQuery.tenantId is `.optional()`, so a scoped token
  // could POST /api/search with NO tenantId, the guard's omission check was a
  // no-op, and `searchByText(query, undefined)` returned EVERY tenant's active
  // memories. The server must derive the effective tenant from the token and
  // scope the search to it — never serve another tenant's row on omission.

  it('a single-tenant token that OMITS tenantId must NOT receive another tenant’s memory (c5k.2)', async () => {
    // Seed a beta-only memory with a distinctive searchable term. Without the
    // fix, an unscoped searchByText('quokka') returns this row to the alpha
    // token; with the fix the search is bound to team-alpha and finds nothing.
    memoryRepo.insert(
      makeMemory({
        tenantId: 'team-beta',
        title: 'Quokka migration runbook',
        content: 'The quokka cutover procedure for team-beta only.',
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: auth(ALPHA_ADMIN),
      // tenantId is deliberately OMITTED — this is the bug surface.
      payload: { query: 'quokka', scope: 'curated' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The alpha token must see ZERO beta rows — the effective tenant was
    // resolved to team-alpha server-side, not left unscoped.
    expect(body.totalCount).toBe(0);
    expect(body.hits).toEqual([]);
  });

  it('a single-tenant token that OMITS tenantId DOES see its own tenant’s memory', async () => {
    // Same query, but the matching row belongs to team-alpha — the injected
    // effective tenant must still let the token reach its own data.
    memoryRepo.insert(
      makeMemory({
        tenantId: 'team-alpha',
        title: 'Quokka migration runbook',
        content: 'The quokka cutover procedure for team-alpha.',
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: auth(ALPHA_ADMIN),
      payload: { query: 'quokka', scope: 'curated' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().totalCount).toBe(1);
  });

  it('a MULTI-tenant token that OMITS tenantId is rejected (400) — it cannot be guessed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: auth(MULTI_ADMIN),
      payload: { query: 'x', scope: 'curated' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---- single-record reads cannot enumerate across tenants ----------------

  it('returns 404 (not the row) when reading another tenant’s memory by UUID', async () => {
    const betaMemory = makeMemory({ tenantId: 'team-beta' });
    memoryRepo.insert(betaMemory);
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${betaMemory.id}`,
      headers: auth(ALPHA_ADMIN),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns the row when reading the token’s OWN tenant memory by UUID', async () => {
    const alphaMemory = makeMemory({ tenantId: 'team-alpha' });
    memoryRepo.insert(alphaMemory);
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${alphaMemory.id}`,
      headers: auth(ALPHA_ADMIN),
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when reading another tenant’s memory by content hash', async () => {
    const betaMemory = makeMemory({ tenantId: 'team-beta', content: 'beta-only secret content' });
    memoryRepo.insert(betaMemory);
    const hash = computeContentHash('beta-only secret content');
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/by-hash/${hash}`,
      headers: auth(ALPHA_ADMIN),
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- raw inbox is admin-only --------------------------------------------

  it('blocks a MEMBER token from reading the raw candidate inbox list (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/candidates?tenantId=team-alpha',
      headers: auth(ALPHA_MEMBER),
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks a MEMBER token from reading a raw candidate by id (403)', async () => {
    const cand = makeCandidate({ tenantId: 'team-alpha' });
    candidateRepo.insert(cand, computeContentHash(cand.content));
    const res = await app.inject({
      method: 'GET',
      url: `/api/candidates/${cand.id}`,
      headers: auth(ALPHA_MEMBER),
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows an ADMIN token to read the raw candidate inbox', async () => {
    const cand = makeCandidate({ tenantId: 'team-alpha' });
    candidateRepo.insert(cand, computeContentHash(cand.content));
    const res = await app.inject({
      method: 'GET',
      url: '/api/candidates?tenantId=team-alpha',
      headers: auth(ALPHA_ADMIN),
    });
    expect(res.statusCode).toBe(200);
  });

  it('still lets a MEMBER PROPOSE (POST /api/candidates) into its own tenant', async () => {
    // The inbox READ lock must not break the propose path members rely on.
    const body = makeCandidate({ tenantId: 'team-alpha' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/candidates',
      headers: auth(ALPHA_MEMBER),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
  });

  // ---- unscoped token is unrestricted (single-tenant team default) --------

  it('an UNSCOPED token may read any tenant (no allowlist = no restriction)', async () => {
    memoryRepo.insert(makeMemory({ tenantId: 'team-beta' }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories?tenantId=team-beta',
      headers: auth(UNSCOPED_ADMIN),
    });
    expect(res.statusCode).toBe(200);
  });

  it('an UNSCOPED token may write any tenant', async () => {
    const body = makeCandidate({ tenantId: 'team-beta' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/candidates',
      headers: auth(UNSCOPED_ADMIN),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
  });

  it('an UNSCOPED token may read any tenant’s memory by UUID', async () => {
    const betaMemory = makeMemory({ tenantId: 'team-beta' });
    memoryRepo.insert(betaMemory);
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${betaMemory.id}`,
      headers: auth(UNSCOPED_ADMIN),
    });
    expect(res.statusCode).toBe(200);
  });
});
