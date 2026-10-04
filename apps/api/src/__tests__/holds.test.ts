import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { buildApp } from '../app.js';
import { buildTokenRegistry } from '../auth/token-registry.js';
import { makeCandidate, makePolicy } from './fixtures.js';

/**
 * The human-escalation hold over the API (Epic K bead K6): the promote path
 * puts an ambiguous candidate on hold; an agent may recommend and nothing more;
 * a person with admin or owner standing resolves. Real SQLite store.
 */

const MEMBER = 'member-token';
const ADMIN = 'admin-token';
const OWNER = 'owner-token';
const AGENT = 'agent-token';
const FLAGGED_AGENT = 'flagged-agent-token';
const TENANT = 'team-alpha';

const TOKENS = [
  { token: MEMBER, actor: 'mia', role: 'member' as const },
  { token: ADMIN, actor: 'adam', role: 'admin' as const },
  { token: OWNER, actor: 'olivia', role: 'admin' as const, owner: true },
  // The 014-AT-DECR review agent: an agent by its actor id, with no flag.
  { token: AGENT, actor: 'teamkb-review-agent', role: 'admin' as const },
  // Any other automation is marked with `agent: true`.
  { token: FLAGGED_AGENT, actor: 'nightly-bot', role: 'admin' as const, agent: true },
];
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const PII = 'Escalate billing questions to dana.whitfield@customer-example.com before Friday.';
const CLEAN = 'Use dependency injection for all services in the codebase, without exception.';

const RULES = [
  { id: 'r-secret', type: 'secret_detection', action: 'reject' },
  { id: 'r-sensitivity', type: 'sensitivity_gate', action: 'flag' },
  { id: 'r-audience', type: 'audience_narrowing', action: 'flag' },
].map((r, i) => ({ enabled: true, priority: i, parameters: {}, ...r }));

// Every request scrypt-verifies the bearer token against each registered token,
// so a test that makes several requests needs more than the 5s default.
describe('human-escalation hold API', { timeout: 30_000 }, () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let candidateRepo: CandidateRepository;
  let memoryRepo: MemoryRepository;
  let auditRepo: AuditRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
    memoryRepo = new MemoryRepository(db);
    auditRepo = new AuditRepository(db);
    new PolicyRepository(db).insert(makePolicy({ tenantId: TENANT, rules: RULES }));
    app = buildApp({ db, silent: true, tokens: TOKENS });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function seed(content: string, metadata: Record<string, unknown> = {}): MemoryCandidate {
    const candidate = makeCandidate({
      tenantId: TENANT,
      content,
      metadata: { filePaths: [], tags: [], ...metadata },
    });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));
    return candidate;
  }

  const post = (token: string, url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url, headers: auth(token), payload });
  const promote = (token: string, id: string, payload: Record<string, unknown> = {}) =>
    post(token, `/api/candidates/${id}/promote?tenantId=${TENANT}`, payload);
  const resolve = (token: string, id: string, payload: Record<string, unknown>) =>
    post(token, `/api/holds/${id}/resolve?tenantId=${TENANT}`, payload);
  const recommend = (token: string, id: string, payload: Record<string, unknown>) =>
    post(token, `/api/holds/${id}/recommend?tenantId=${TENANT}`, payload);
  const list = (token: string, tenantId = TENANT) =>
    app.inject({ method: 'GET', url: `/api/holds?tenantId=${tenantId}`, headers: auth(token) });

  const statusOf = (id: string) => candidateRepo.findById(id)!.status;
  const actionsFor = (id: string) => auditRepo.findByMemory(id).map((e) => e.action);

  /** Seed a PII candidate and put it on hold through the promote path. */
  async function seedHeld(metadata: Record<string, unknown> = {}): Promise<MemoryCandidate> {
    const candidate = seed(PII, metadata);
    const res = await promote(ADMIN, candidate.id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'held_for_review' });
    return candidate;
  }

  describe('entry through POST /api/candidates/:id/promote', () => {
    it('an approval of an ambiguous candidate holds it instead of promoting it', async () => {
      const candidate = seed(PII);
      const res = await promote(AGENT, candidate.id, { reason: 'looks useful', actorType: 'ai' });

      expect(res.statusCode).toBe(422);
      const body = res.json() as { code: string; error: string };
      expect(body.code).toBe('held_for_review');
      expect(body.error).toContain('audience_narrowing_flag');
      expect(body.error).not.toContain('dana.whitfield');
      expect(statusOf(candidate.id)).toBe('quarantined');
      expect(memoryRepo.count()).toBe(0);
      expect(actionsFor(candidate.id)).toEqual(['held']);
      // The rule placed the hold (the actor); the receipt also names whose
      // approval ran into it.
      expect(auditRepo.findByMemory(candidate.id)[0]).toMatchObject({
        actor: { type: 'system', id: 'hold-gate' },
        details: { triggeredBy: { type: 'ai', id: 'teamkb-review-agent' } },
      });
    });

    it('approving again is idempotent: still held, no second receipt', async () => {
      const candidate = await seedHeld();
      const res = await promote(AGENT, candidate.id, { reason: 'retry', actorType: 'ai' });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'held_for_review' });
      expect(actionsFor(candidate.id)).toEqual(['held']);
      expect(memoryRepo.count()).toBe(0);
    });

    it('a clean candidate still promotes', async () => {
      const candidate = seed(CLEAN);
      expect((await promote(ADMIN, candidate.id)).statusCode).toBe(200);
      expect(statusOf(candidate.id)).toBe('promoted');
    });

    it('holds a member proposal that declares an audience members cannot read', async () => {
      const candidate = seed(CLEAN, { audience: 'admins', proposedByRole: 'member' });
      const res = await promote(ADMIN, candidate.id);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'held_for_review' });
      expect((res.json() as { error: string }).error).toContain(
        'audience_above_proposer_clearance',
      );
    });

    it('fails closed past the cap: not held, not promoted, reported', async () => {
      await app.close();
      app = buildApp({ db, silent: true, tokens: TOKENS, holdLimits: { maxActiveHolds: 1 } });
      await app.ready();
      await seedHeld();
      const second = seed(`${PII} Second copy.`);
      const res = await promote(ADMIN, second.id);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'hold_cap_reached' });
      expect(statusOf(second.id)).toBe('inbox');
      expect(memoryRepo.count()).toBe(0);
    });

    it('the reviewer reject path cannot retire a held candidate', async () => {
      const candidate = await seedHeld();
      const res = await post(AGENT, `/api/candidates/${candidate.id}/reject?tenantId=${TENANT}`, {
        reason: 'noise',
        actorType: 'ai',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'on_hold' });
      expect(statusOf(candidate.id)).toBe('quarantined');
      expect(actionsFor(candidate.id)).toEqual(['held']);
    });
  });

  describe('GET /api/holds', () => {
    it('lists open holds for an admin, with no candidate content', async () => {
      const candidate = await seedHeld();
      const res = await list(ADMIN);
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        count: number;
        maxActive: number;
        hiddenAboveStanding: number;
        holds: Array<Record<string, unknown>>;
      };
      expect(body).toMatchObject({ tenantId: TENANT, count: 1, maxActive: 100 });
      expect(body.hiddenAboveStanding).toBe(0);
      expect(body.holds[0]).toMatchObject({
        candidateId: candidate.id,
        declaredAudience: 'tenant',
        recommendedAudience: 'admins',
        triggers: ['audience_narrowing_flag', 'sensitivity_gate_flag'],
        expired: false,
      });
      expect(res.body).not.toContain('dana.whitfield');
    });

    it('refuses a member and requires a tenant', async () => {
      await seedHeld();
      expect((await list(MEMBER)).statusCode).toBe(403);
      const res = await app.inject({ method: 'GET', url: '/api/holds', headers: auth(ADMIN) });
      expect(res.statusCode).toBe(400);
    });

    it('hides an owner-audience hold from a plain admin and counts it', async () => {
      const candidate = seed(CLEAN, { audience: 'owner', proposedByRole: 'member' });
      await promote(OWNER, candidate.id);
      expect(statusOf(candidate.id)).toBe('quarantined');

      const asAdmin = (await list(ADMIN)).json() as { count: number; hiddenAboveStanding: number };
      expect(asAdmin).toMatchObject({ count: 0, hiddenAboveStanding: 1 });
      const asOwner = (await list(OWNER)).json() as { count: number };
      expect(asOwner.count).toBe(1);

      // The admin cannot resolve or recommend on what they cannot see: 404.
      const res = await resolve(ADMIN, candidate.id, { resolution: 'reject', reason: 'no' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_on_hold' });
      expect(
        (await recommend(ADMIN, candidate.id, { verdict: 'reject', reasoning: 'no' })).statusCode,
      ).toBe(404);
      expect(statusOf(candidate.id)).toBe('quarantined');
    });
  });

  describe('POST /api/holds/:id/recommend — advice only', () => {
    it('an agent’s recommendation is receipted and changes no state', async () => {
      const candidate = await seedHeld();
      const res = await recommend(AGENT, candidate.id, {
        verdict: 'release',
        audience: 'tenant',
        reasoning: 'A public support address.',
        // An agent token is recorded as `ai` whatever the body claims.
        actorType: 'human',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, duplicate: false });

      expect(statusOf(candidate.id)).toBe('quarantined');
      expect(memoryRepo.count()).toBe(0);
      const events = auditRepo.findByMemory(candidate.id);
      expect(events.map((e) => e.action)).toEqual(['held', 'hold_recommended']);
      expect(events[1]).toMatchObject({
        actor: { type: 'ai', id: 'teamkb-review-agent' },
        reason: 'A public support address.',
        details: { verdict: 'release', audience: 'tenant' },
      });

      const listed = (await list(ADMIN)).json() as {
        holds: Array<{ recommendations: Array<Record<string, unknown>> }>;
      };
      expect(listed.holds[0]!.recommendations[0]).toMatchObject({
        verdict: 'release',
        audience: 'tenant',
      });
    });

    it('refuses a member, a malformed body and a candidate that is not on hold', async () => {
      const candidate = await seedHeld();
      const body = { verdict: 'reject', reasoning: 'noise' };
      expect((await recommend(MEMBER, candidate.id, body)).statusCode).toBe(403);
      expect((await recommend(ADMIN, candidate.id, { reasoning: 'x' })).statusCode).toBe(400);
      expect((await recommend(ADMIN, candidate.id, { verdict: 'reject' })).statusCode).toBe(400);
      expect(
        (await recommend(ADMIN, candidate.id, { ...body, verdict: 'promote' })).statusCode,
      ).toBe(400);
      expect((await recommend(ADMIN, seed(CLEAN).id, body)).statusCode).toBe(404);
      expect(actionsFor(candidate.id)).toEqual(['held']);
    });
  });

  describe('POST /api/holds/:id/resolve — a person with standing', () => {
    const RELEASE = { resolution: 'release', audience: 'admins', reason: 'customer contact' };

    it('refuses an agent token, by actor id and by flag, and a self-declared ai', async () => {
      const candidate = await seedHeld();
      for (const [token, payload] of [
        [AGENT, RELEASE],
        [FLAGGED_AGENT, RELEASE],
        [ADMIN, { ...RELEASE, actorType: 'ai' }],
        [ADMIN, { ...RELEASE, actorType: 'system' }],
        [AGENT, { resolution: 'reject', reason: 'noise' }],
      ] as const) {
        const res = await resolve(token, candidate.id, payload);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'human_required' });
      }
      expect(statusOf(candidate.id)).toBe('quarantined');
      expect(memoryRepo.count()).toBe(0);
      expect(actionsFor(candidate.id)).toEqual(['held']);
    });

    it('refuses a member', async () => {
      const candidate = await seedHeld();
      expect((await resolve(MEMBER, candidate.id, RELEASE)).statusCode).toBe(403);
      expect(statusOf(candidate.id)).toBe('quarantined');
    });

    it('an admin releases with a chosen audience; receipts name the authenticated caller', async () => {
      const candidate = await seedHeld();
      const res = await resolve(ADMIN, candidate.id, RELEASE);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { memoryId: string; auditEventId: string };
      expect(body).toMatchObject({
        ok: true,
        candidateId: candidate.id,
        resolution: 'released',
        audience: 'admins',
        overridesRecommendation: false,
      });
      // The response carries no memory content.
      expect(res.body).not.toContain('dana.whitfield');

      const memory = memoryRepo.findById(body.memoryId)!;
      expect(memory.metadata.audience).toBe('admins');
      expect(memory.promotedBy).toEqual({ type: 'human', id: 'adam' });
      expect(statusOf(candidate.id)).toBe('promoted');

      const resolved = auditRepo
        .findByMemory(candidate.id)
        .find((e) => e.action === 'hold_resolved')!;
      expect(resolved).toMatchObject({
        id: body.auditEventId,
        actor: { type: 'human', id: 'adam' },
        reason: 'customer contact',
        details: { resolution: 'released', audience: 'admins', resolverRole: 'admin' },
      });
      expect(verifyAuditChain(auditRepo).breaks).toEqual([]);

      // Resolving twice is refused and writes nothing.
      const again = await resolve(ADMIN, candidate.id, RELEASE);
      expect(again.statusCode).toBe(404);
      expect(memoryRepo.count()).toBe(1);
    });

    it('a wider audience than recommended needs acknowledgeWider: true (strictly)', async () => {
      const candidate = await seedHeld();
      const wide = { ...RELEASE, audience: 'tenant' };
      for (const payload of [wide, { ...wide, acknowledgeWider: 'true' }]) {
        const res = await resolve(ADMIN, candidate.id, payload);
        expect(res.statusCode).toBe(422);
        expect(res.json()).toMatchObject({ code: 'wider_than_recommended' });
      }
      expect(statusOf(candidate.id)).toBe('quarantined');

      const res = await resolve(ADMIN, candidate.id, { ...wide, acknowledgeWider: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ audience: 'tenant', overridesRecommendation: true });
    });

    it('refreshes the index after a release, and a failed refresh does not fail the release', async () => {
      const refreshed: string[] = [];
      let fail = false;
      await app.close();
      app = buildApp({
        db,
        silent: true,
        tokens: TOKENS,
        indexRefresher: {
          refreshAfterPromotion: async (tenantId) => {
            refreshed.push(tenantId);
            if (fail) throw new Error('qmd unavailable');
            return { ok: true };
          },
        },
      });
      await app.ready();

      const first = await seedHeld();
      expect((await resolve(ADMIN, first.id, RELEASE)).statusCode).toBe(200);
      // A reject promotes nothing, so it refreshes nothing.
      const second = seed(`${PII} Second copy.`);
      await promote(ADMIN, second.id);
      await resolve(ADMIN, second.id, { resolution: 'reject', reason: 'noise' });
      expect(refreshed).toEqual([TENANT]);

      fail = true;
      const third = seed(`${PII} Third copy.`);
      await promote(ADMIN, third.id);
      expect((await resolve(ADMIN, third.id, RELEASE)).statusCode).toBe(200);
      expect(statusOf(third.id)).toBe('promoted');
    });

    it('an admin rejects; the candidate is retired and never promoted', async () => {
      const candidate = await seedHeld();
      const res = await resolve(ADMIN, candidate.id, { resolution: 'reject', reason: 'noise' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, resolution: 'rejected' });
      expect(statusOf(candidate.id)).toBe('rejected');
      expect(memoryRepo.count()).toBe(0);
      expect(actionsFor(candidate.id)).toEqual(['held', 'hold_resolved']);
      // Once resolved it can never be promoted by a later approval either.
      expect((await promote(ADMIN, candidate.id)).statusCode).toBe(422);
      expect(memoryRepo.count()).toBe(0);
    });

    it('answers 400 to a malformed body and 404 to a candidate that is not on hold', async () => {
      const candidate = await seedHeld();
      expect((await resolve(ADMIN, candidate.id, { reason: 'x' })).statusCode).toBe(400);
      expect((await resolve(ADMIN, candidate.id, { resolution: 'release' })).statusCode).toBe(400);
      expect(
        (await resolve(ADMIN, candidate.id, { resolution: 'release', reason: 'x' })).statusCode,
      ).toBe(400);
      expect(
        (await resolve(ADMIN, candidate.id, { ...RELEASE, audience: 'board' })).statusCode,
      ).toBe(400);
      expect((await resolve(ADMIN, candidate.id, { ...RELEASE, audience: 7 })).statusCode).toBe(
        400,
      );
      expect((await resolve(ADMIN, seed(CLEAN).id, RELEASE)).statusCode).toBe(404);
      expect((await post(ADMIN, `/api/holds/${candidate.id}/resolve`, RELEASE)).statusCode).toBe(
        400,
      );
      expect(statusOf(candidate.id)).toBe('quarantined');
    });
  });
});

describe('agent tokens', () => {
  it('carries the agent flag only when it is exactly true', () => {
    const registry = buildTokenRegistry({
      tokensJson: JSON.stringify([
        { token: 'a', actor: 'bot', role: 'admin', agent: true },
        { token: 'b', actor: 'person', role: 'admin', agent: 'true' },
        { token: 'c', actor: 'other', role: 'admin' },
      ]),
    });
    expect(registry.resolve('a')?.agent).toBe(true);
    expect(registry.resolve('b')?.agent).toBeUndefined();
    expect(registry.resolve('c')?.agent).toBeUndefined();
  });
});
