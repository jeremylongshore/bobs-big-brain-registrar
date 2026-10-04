/**
 * Bounded human-escalation HOLD (Epic K bead K6) on a FILE-backed SQLite store,
 * so every assertion is about what was durably written.
 *
 * Covers: entry by a deterministic rule outcome; a model's recommendation never
 * changing state; expiry to the safe default under a frozen clock; the cap; the
 * human resolve paths with role checks; receipts that chain and verify;
 * idempotence; and dry-run writing nothing.
 *
 * @module __tests__/hold.test
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeContentHash } from '@qmd-team-intent-kb/common';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createDatabase,
  createTestDatabase,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, type CuratorCliDeps } from '../cli.js';
import { Curator } from '../curator.js';
import {
  DEFAULT_HOLD_TTL_DAYS,
  DEFAULT_MAX_ACTIVE_HOLDS,
  MAX_RECOMMENDATIONS_PER_HOLD,
  expireHolds,
  findActiveHold,
  holdLimitsFromEnv,
  listActiveHolds,
  recommendOnHold,
} from '../hold/hold.js';
import { resolveHold } from '../hold/resolve-hold.js';
import type { ResolveHoldInput } from '../hold/resolve-hold.js';
import type { CuratorConfig } from '../types.js';
import { makeCandidate, makePolicy, TENANT } from './fixtures.js';

const T0 = '2026-10-04T12:00:00.000Z';
const DAY_MS = 86_400_000;
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();
const EXPIRY = at(DEFAULT_HOLD_TTL_DAYS * DAY_MS);

/** PII-shaped content: the classifier sees it, the disclosure choke point admits it. */
const pii = (n: number): string =>
  `Escalate billing question ${n} to dana.whitfield${n}@customer-example.com before Friday.`;
const CLEAN = 'Use dependency injection for all services in the codebase, without exception.';

const RULES = [
  { id: 'r-secret', type: 'secret_detection', action: 'reject' },
  { id: 'r-sensitivity', type: 'sensitivity_gate', action: 'flag' },
  { id: 'r-audience', type: 'audience_narrowing', action: 'flag' },
  { id: 'r-sanitize', type: 'content_sanitization', action: 'flag' },
].map((r, i) => ({ enabled: true, priority: i, parameters: {}, ...r }));

let dir: string;
let dbPath: string;
let db: ReturnType<typeof createDatabase>;
let candidates: CandidateRepository;
let memories: MemoryRepository;
let policies: PolicyRepository;
let audit: AuditRepository;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hold-'));
  dbPath = join(dir, 'teamkb.db');
  // The CLI resolves the origin secret and brainignore file under the brain base
  // path: point it at the temp dir so no test reads or writes a real brain.
  savedEnv = {
    TEAMKB_BASE_PATH: process.env['TEAMKB_BASE_PATH'],
    TEAMKB_ORIGIN_SECRET: process.env['TEAMKB_ORIGIN_SECRET'],
    TEAMKB_BRAINIGNORE: process.env['TEAMKB_BRAINIGNORE'],
    TEAMKB_HOLD_MAX_ACTIVE: process.env['TEAMKB_HOLD_MAX_ACTIVE'],
    TEAMKB_HOLD_TTL_DAYS: process.env['TEAMKB_HOLD_TTL_DAYS'],
  };
  process.env['TEAMKB_BASE_PATH'] = dir;
  for (const key of Object.keys(savedEnv).filter((k) => k !== 'TEAMKB_BASE_PATH')) {
    delete process.env[key];
  }
  open();
  policies.insert(makePolicy({ rules: RULES }));
  // The test policy is deliberately partial; silence the dormant-rule notice.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

function open(readonly = false): void {
  db = createDatabase({ path: dbPath, readonly });
  candidates = new CandidateRepository(db);
  memories = new MemoryRepository(db);
  policies = new PolicyRepository(db);
  audit = new AuditRepository(db);
}

const repos = () => ({
  candidateRepo: candidates,
  memoryRepo: memories,
  auditRepo: audit,
  policyRepo: policies,
});

function curator(config: Partial<CuratorConfig> = {}): Curator {
  return new Curator(repos(), { tenantId: TENANT, now: () => T0, ...config });
}

/** Insert an inbox candidate into the store and return it. */
function seed(content: string, metadata: Record<string, unknown> = {}): MemoryCandidate {
  const candidate = makeCandidate({ content, metadata: { filePaths: [], tags: [], ...metadata } });
  candidates.insert(candidate, computeContentHash(candidate.content));
  return candidate;
}

/** Seed a PII candidate and run it through the curator so it lands on hold. */
function seedHeld(n = 1, metadata: Record<string, unknown> = {}): MemoryCandidate {
  const candidate = seed(pii(n), metadata);
  expect(curator().processSingle(candidate).outcome).toBe('held');
  return candidate;
}

const statusOf = (id: string): string => candidates.findById(id)!.status;
const auditCount = (): number => audit.findAllChronological().length;
const actionsFor = (id: string): string[] => audit.findByMemory(id).map((e) => e.action);
const fileSha = (): string => createHash('sha256').update(readFileSync(dbPath)).digest('hex');

function resolveInput(candidateId: string, overrides: Partial<ResolveHoldInput> = {}) {
  return {
    candidateId,
    tenantId: TENANT,
    resolution: 'release',
    audience: 'admins',
    actor: { type: 'human' as const, id: 'jeremy' },
    role: 'admin',
    reason: 'customer contact, admins only',
    now: at(DAY_MS),
    ...overrides,
  };
}

describe('hold entry — a deterministic rule outcome', () => {
  it('holds a flagged candidate: quarantined, receipted, not promoted, not dropped', () => {
    const candidate = seed(pii(1));
    const result = curator().processSingle(candidate);

    expect(result).toMatchObject({
      outcome: 'held',
      hold: {
        status: 'held',
        triggers: ['audience_narrowing_flag', 'sensitivity_gate_flag'],
        recommendedAudience: 'admins',
        expiresAt: EXPIRY,
      },
    });
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(memories.count()).toBe(0);
    expect(candidates.findById(candidate.id)!.content).toBe(candidate.content);

    const events = audit.findByMemory(candidate.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'held',
      actor: { type: 'system', id: 'hold-gate' },
      timestamp: T0,
      details: {
        candidateId: candidate.id,
        triggers: ['audience_narrowing_flag', 'sensitivity_gate_flag'],
        declaredAudience: 'tenant',
        recommendedAudience: 'admins',
        triggerRuleIds: ['r-sensitivity', 'r-audience'],
        otherFlags: [],
        ttlDays: DEFAULT_HOLD_TTL_DAYS,
        expiresAt: EXPIRY,
      },
    });
    // The receipt names patterns, never the text that matched.
    expect(JSON.stringify(events[0])).not.toContain('dana.whitfield');
    expect(verifyAuditChain(audit).breaks).toEqual([]);
  });

  it('still promotes a clean candidate and still rejects a hard reject', () => {
    expect(curator().processSingle(seed(CLEAN)).outcome).toBe('promoted');
    const secret = makeCandidate({
      content: 'The deploy step reads DEPLOY_' + 'PASSWORD=' + 'correct-horse-battery at boot.',
    });
    expect(curator().processSingle(secret).outcome).toBe('rejected');
    expect(listActiveHolds(TENANT, repos(), T0)).toEqual([]);
  });

  it('holds a member proposal declaring an audience members cannot read, with no policy', () => {
    for (const policy of policies.findByTenant(TENANT)) policies.delete(policy.id);
    const candidate = seed(CLEAN, { audience: 'admins', proposedByRole: 'member' });
    const result = curator().processSingle(candidate);
    expect(result).toMatchObject({
      outcome: 'held',
      hold: { triggers: ['audience_above_proposer_clearance'], recommendedAudience: 'admins' },
    });
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(memories.count()).toBe(0);
  });

  it('is idempotent: a second pass over a held candidate writes nothing', () => {
    const candidate = seedHeld();
    const before = auditCount();
    const again = curator().processSingle(candidate);
    expect(again).toMatchObject({ outcome: 'held', hold: { status: 'already_held' } });
    expect(auditCount()).toBe(before);
    expect(actionsFor(candidate.id)).toEqual(['held']);
  });

  it('dry-run reports the hold and writes nothing', () => {
    const candidate = seed(pii(1));
    const before = auditCount();
    const result = curator({ dryRun: true }).processSingle(candidate);
    expect(result).toMatchObject({ outcome: 'held', hold: { status: 'would_hold' } });
    expect(statusOf(candidate.id)).toBe('inbox');
    expect(auditCount()).toBe(before);
  });

  it('does not promote a triggering candidate that has no stored row to hold', () => {
    const unstored = makeCandidate({ content: pii(9) });
    const result = curator().processSingle(unstored);
    expect(result).toMatchObject({ outcome: 'flagged', hold: { status: 'not_holdable' } });
    expect(memories.count()).toBe(0);
  });

  it('honours a configured expiry', () => {
    const candidate = seed(pii(1));
    const result = curator({ holdLimits: { ttlDays: 2 } }).processSingle(candidate);
    expect(result.hold?.expiresAt).toBe(at(2 * DAY_MS));
  });

  it('reads the bounds from the environment and ignores unusable values', () => {
    expect(holdLimitsFromEnv({})).toEqual({});
    expect(holdLimitsFromEnv({ TEAMKB_HOLD_TTL_DAYS: '7', TEAMKB_HOLD_MAX_ACTIVE: '25' })).toEqual({
      ttlDays: 7,
      maxActiveHolds: 25,
    });
    expect(
      holdLimitsFromEnv({ TEAMKB_HOLD_TTL_DAYS: '-1', TEAMKB_HOLD_MAX_ACTIVE: 'lots' }),
    ).toEqual({});
  });
});

describe('the cap — fail closed past it', () => {
  it('holds up to the cap, then leaves the rest unheld and unpromoted, and reports it', () => {
    const batch = [seed(pii(1)), seed(pii(2)), seed(pii(3))];
    const result = curator({ holdLimits: { maxActiveHolds: 2 } }).processBatch(batch);

    expect(result).toMatchObject({ held: 2, holdCapBlocked: 1, flagged: 1, promoted: 0 });
    const blocked = result.results[2]!;
    expect(blocked).toMatchObject({ outcome: 'flagged', hold: { status: 'cap_reached' } });
    expect(blocked.reason).toContain('the hold queue is full (2/2)');
    expect(blocked.reason).toContain('Not promoted');
    // Neither promoted nor dropped: it is still in the inbox, content intact.
    expect(statusOf(batch[2]!.id)).toBe('inbox');
    expect(memories.count()).toBe(0);
    expect(listActiveHolds(TENANT, repos(), T0)).toHaveLength(2);
  });

  it('takes the blocked candidate once a slot frees up', () => {
    const batch = [seed(pii(1)), seed(pii(2))];
    const limits = { holdLimits: { maxActiveHolds: 1 } };
    expect(curator(limits).processBatch(batch)).toMatchObject({ held: 1, holdCapBlocked: 1 });

    const rejected = resolveHold(resolveInput(batch[0]!.id, { resolution: 'reject' }), repos());
    expect(rejected.ok).toBe(true);
    expect(curator(limits).processSingle(batch[1]!).outcome).toBe('held');
  });

  it('a cap of zero holds nothing and promotes nothing', () => {
    const candidate = seed(pii(1));
    const result = curator({ holdLimits: { maxActiveHolds: 0 } }).processSingle(candidate);
    expect(result).toMatchObject({ outcome: 'flagged', hold: { status: 'cap_reached' } });
    expect(memories.count()).toBe(0);
  });

  it('defaults to a finite cap', () => {
    expect(DEFAULT_MAX_ACTIVE_HOLDS).toBe(100);
  });
});

describe('a model may only recommend', () => {
  it('a recommendation writes one receipt and changes no state', () => {
    const candidate = seedHeld();
    const stored = JSON.stringify(candidates.findById(candidate.id));

    const result = recommendOnHold(
      {
        candidateId: candidate.id,
        tenantId: TENANT,
        actor: { type: 'ai', id: 'teamkb-review-agent' },
        verdict: 'release',
        audience: 'tenant',
        reasoning: 'Looks like a public support address.',
        now: at(1000),
      },
      repos(),
    );

    expect(result).toMatchObject({ ok: true, duplicate: false });
    // The model said "release, tenant-wide". Nothing was released.
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(JSON.stringify(candidates.findById(candidate.id))).toBe(stored);
    expect(memories.count()).toBe(0);
    expect(actionsFor(candidate.id)).toEqual(['held', 'hold_recommended']);

    const hold = findActiveHold(candidate.id, TENANT, repos(), at(1000))!;
    expect(hold.recommendations).toEqual([
      {
        auditEventId: result.ok ? result.auditEventId : '',
        actor: { type: 'ai', id: 'teamkb-review-agent' },
        verdict: 'release',
        audience: 'tenant',
        reasoning: 'Looks like a public support address.',
        at: at(1000),
      },
    ]);
    expect(verifyAuditChain(audit).breaks).toEqual([]);
  });

  it('a model cannot resolve: release and reject are both refused, nothing changes', () => {
    const candidate = seedHeld();
    const before = auditCount();
    for (const resolution of ['release', 'reject']) {
      for (const type of ['ai', 'system'] as const) {
        const result = resolveHold(
          resolveInput(candidate.id, { resolution, actor: { type, id: 'teamkb-review-agent' } }),
          repos(),
        );
        expect(result).toMatchObject({ ok: false, code: 'not_human' });
      }
    }
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(memories.count()).toBe(0);
    expect(auditCount()).toBe(before);
  });

  it('repeating the same recommendation is a no-op, and the count is bounded', () => {
    const candidate = seedHeld();
    const recommend = (actorId: string, verdict = 'reject') =>
      recommendOnHold(
        {
          candidateId: candidate.id,
          tenantId: TENANT,
          actor: { type: 'ai', id: actorId },
          verdict,
          reasoning: 'noise',
          now: at(1000),
        },
        repos(),
      );

    const first = recommend('agent-0');
    const before = auditCount();
    expect(recommend('agent-0')).toMatchObject({
      ok: true,
      duplicate: true,
      auditEventId: first.ok ? first.auditEventId : '',
    });
    expect(auditCount()).toBe(before);

    for (let i = 1; i < MAX_RECOMMENDATIONS_PER_HOLD; i++) {
      expect(recommend(`agent-${i}`).ok).toBe(true);
    }
    expect(recommend('agent-overflow')).toMatchObject({ ok: false, code: 'recommendation_cap' });
    expect(statusOf(candidate.id)).toBe('quarantined');
  });

  it('refuses a malformed recommendation and one for a candidate not on hold', () => {
    const candidate = seedHeld();
    const base = {
      candidateId: candidate.id,
      tenantId: TENANT,
      actor: { type: 'ai' as const, id: 'agent' },
      verdict: 'release',
      reasoning: 'because',
      now: at(1000),
    };
    const before = auditCount();
    expect(recommendOnHold({ ...base, reasoning: ' ' }, repos())).toMatchObject({
      code: 'missing_reasoning',
    });
    expect(recommendOnHold({ ...base, verdict: 'promote' }, repos())).toMatchObject({
      code: 'unknown_verdict',
    });
    expect(recommendOnHold({ ...base, audience: 'board' }, repos())).toMatchObject({
      code: 'unknown_audience',
    });
    expect(recommendOnHold({ ...base, actor: { type: 'ai', id: ' ' } }, repos())).toMatchObject({
      code: 'missing_actor',
    });
    expect(recommendOnHold({ ...base, tenantId: 'other-tenant' }, repos())).toMatchObject({
      code: 'not_on_hold',
    });
    expect(recommendOnHold({ ...base, candidateId: seed(CLEAN).id }, repos())).toMatchObject({
      code: 'not_on_hold',
    });
    // Past its bound a hold takes no recommendation — and is NOT expired by one.
    expect(recommendOnHold({ ...base, now: EXPIRY }, repos())).toMatchObject({
      code: 'hold_expired',
    });
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(auditCount()).toBe(before);
  });
});

describe('expiry — the safe default, under a frozen clock', () => {
  it('does nothing one millisecond early and closes the hold unpromoted at the bound', () => {
    const candidate = seedHeld();
    const justBefore = at(DEFAULT_HOLD_TTL_DAYS * DAY_MS - 1);

    expect(expireHolds(TENANT, repos(), { now: justBefore })).toEqual([]);
    expect(findActiveHold(candidate.id, TENANT, repos(), justBefore)!.expired).toBe(false);
    expect(statusOf(candidate.id)).toBe('quarantined');

    const expired = expireHolds(TENANT, repos(), { now: EXPIRY });
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ candidateId: candidate.id, expiresAt: EXPIRY });

    // Not promoted, not deleted: stamped rejected, with an `expired` receipt.
    expect(statusOf(candidate.id)).toBe('rejected');
    expect(memories.count()).toBe(0);
    const events = audit.findByMemory(candidate.id);
    expect(events.map((e) => e.action)).toEqual(['held', 'hold_resolved']);
    expect(events[1]).toMatchObject({
      id: expired[0]!.auditEventId,
      actor: { type: 'system', id: 'hold-expiry' },
      timestamp: EXPIRY,
      details: { resolution: 'expired', expiresAt: EXPIRY, holdEventId: events[0]!.id },
    });
    expect(verifyAuditChain(audit).breaks).toEqual([]);
  });

  it('is idempotent and never reopens or promotes an expired candidate', () => {
    const candidate = seedHeld();
    expireHolds(TENANT, repos(), { now: EXPIRY });
    const before = auditCount();

    expect(expireHolds(TENANT, repos(), { now: at(30 * DAY_MS) })).toEqual([]);
    expect(resolveHold(resolveInput(candidate.id, { now: EXPIRY }), repos())).toMatchObject({
      ok: false,
      code: 'not_on_hold',
    });
    // A later governance pass over the same row cannot hold or promote it again.
    const sweep = curator({ suppressRejectionReceipts: true });
    expect(sweep.processSingle(candidates.findById(candidate.id)!)).toMatchObject({
      outcome: 'flagged',
      hold: { status: 'not_holdable' },
    });
    expect(auditCount()).toBe(before);
    expect(statusOf(candidate.id)).toBe('rejected');
    expect(memories.count()).toBe(0);
  });

  it('a release attempted after the bound is refused and closes the hold unpromoted', () => {
    const candidate = seedHeld();
    const result = resolveHold(resolveInput(candidate.id, { now: EXPIRY }), repos());
    expect(result).toMatchObject({ ok: false, code: 'hold_expired', expiredNow: true });
    expect(statusOf(candidate.id)).toBe('rejected');
    expect(memories.count()).toBe(0);
    expect(actionsFor(candidate.id)).toEqual(['held', 'hold_resolved']);
  });

  it('dry-run expiry reports and writes nothing', () => {
    const candidate = seedHeld();
    const before = auditCount();
    const would = expireHolds(TENANT, repos(), { now: EXPIRY, dryRun: true });
    expect(would).toEqual([{ candidateId: candidate.id, expiresAt: EXPIRY, auditEventId: null }]);
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(auditCount()).toBe(before);
  });
});

describe('resolve — a human with standing', () => {
  it('refuses a member, an unknown role, and a hold above the resolver’s standing', () => {
    const candidate = seedHeld();
    const before = auditCount();
    for (const role of ['member', 'guest', '']) {
      expect(resolveHold(resolveInput(candidate.id, { role }), repos())).toMatchObject({
        ok: false,
        code: 'forbidden_role',
      });
    }
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(memories.count()).toBe(0);
    expect(auditCount()).toBe(before);
  });

  it('an admin cannot resolve an owner-audience hold; the owner can', () => {
    for (const policy of policies.findByTenant(TENANT)) policies.delete(policy.id);
    const candidate = seed(CLEAN, { audience: 'owner', proposedByRole: 'member' });
    expect(curator().processSingle(candidate).outcome).toBe('held');

    expect(resolveHold(resolveInput(candidate.id, { audience: 'owner' }), repos())).toMatchObject({
      ok: false,
      code: 'audience_above_standing',
    });
    expect(statusOf(candidate.id)).toBe('quarantined');

    const released = resolveHold(
      resolveInput(candidate.id, { audience: 'owner', role: 'owner' }),
      repos(),
    );
    expect(released).toMatchObject({ ok: true, resolution: 'released', audience: 'owner' });
  });

  it('refuses a malformed request without touching the hold', () => {
    const candidate = seedHeld();
    const before = auditCount();
    const refusal = (overrides: Partial<ResolveHoldInput>) =>
      resolveHold(resolveInput(candidate.id, overrides), repos());

    expect(refusal({ reason: ' ' })).toMatchObject({ code: 'missing_reason' });
    expect(refusal({ actor: { type: 'human', id: '' } })).toMatchObject({ code: 'missing_actor' });
    expect(refusal({ resolution: 'approve' })).toMatchObject({ code: 'unknown_resolution' });
    expect(refusal({ audience: undefined })).toMatchObject({ code: 'missing_audience' });
    expect(refusal({ audience: 'board' })).toMatchObject({ code: 'unknown_audience' });
    expect(refusal({ tenantId: 'other-tenant' })).toMatchObject({ code: 'not_on_hold' });
    expect(resolveHold(resolveInput(seed(CLEAN).id), repos())).toMatchObject({
      code: 'not_on_hold',
    });
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(auditCount()).toBe(before);
  });

  it('releases with the chosen audience: memory, both receipts and status in one transaction', () => {
    const candidate = seedHeld();
    const result = resolveHold(resolveInput(candidate.id), repos());

    expect(result).toMatchObject({
      ok: true,
      resolution: 'released',
      audience: 'admins',
      overridesRecommendation: false,
      dryRun: false,
    });
    if (!result.ok) throw new Error('expected a release');

    const memory = memories.findById(result.memoryId!)!;
    expect(memory.metadata.audience).toBe('admins');
    expect(memory.content).toBe(candidate.content);
    expect(memory.promotedBy).toEqual({ type: 'human', id: 'jeremy' });
    expect(statusOf(candidate.id)).toBe('promoted');
    // The candidate row keeps what was PROPOSED; the memory carries the decision.
    expect(candidates.findById(candidate.id)!.metadata.audience).toBeUndefined();

    const promoted = audit.findByMemory(memory.id).find((e) => e.action === 'promoted')!;
    expect(promoted.actor).toEqual({ type: 'human', id: 'jeremy' });
    expect(promoted.reason).toContain('Released from hold: customer contact, admins only');
    expect(promoted.reason).toContain('flags resolved by a human releasing a hold');
    // At the chosen audience the audience rule passes; the sensitivity flag is
    // the one a person resolved.
    expect(promoted.details['humanResolvedFlags']).toEqual(['r-sensitivity']);

    const events = audit.findByMemory(candidate.id);
    expect(events.map((e) => e.action)).toEqual(['held', 'hold_resolved']);
    expect(events[1]).toMatchObject({
      id: result.auditEventId,
      actor: { type: 'human', id: 'jeremy' },
      reason: 'customer contact, admins only',
      timestamp: at(DAY_MS),
      details: {
        resolution: 'released',
        audience: 'admins',
        declaredAudience: 'tenant',
        recommendedAudience: 'admins',
        overridesRecommendation: false,
        resolverRole: 'admin',
        memoryId: memory.id,
        resolvedFlags: ['r-sensitivity'],
        holdEventId: events[0]!.id,
      },
    });
    expect(verifyAuditChain(audit).breaks).toEqual([]);
    expect(listActiveHolds(TENANT, repos(), at(DAY_MS))).toEqual([]);
  });

  it('is idempotent: resolving a resolved hold is refused and writes nothing', () => {
    const candidate = seedHeld();
    expect(resolveHold(resolveInput(candidate.id), repos()).ok).toBe(true);
    const before = auditCount();
    for (const resolution of ['release', 'reject']) {
      expect(resolveHold(resolveInput(candidate.id, { resolution }), repos())).toMatchObject({
        ok: false,
        code: 'not_on_hold',
      });
    }
    expect(auditCount()).toBe(before);
    expect(memories.count()).toBe(1);
  });

  it('a wider audience than recommended needs an explicit acknowledgment', () => {
    const candidate = seedHeld();
    const before = auditCount();
    expect(resolveHold(resolveInput(candidate.id, { audience: 'tenant' }), repos())).toMatchObject({
      ok: false,
      code: 'wider_than_recommended',
    });
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(auditCount()).toBe(before);

    const result = resolveHold(
      resolveInput(candidate.id, { audience: 'tenant', acknowledgeWider: true }),
      repos(),
    );
    expect(result).toMatchObject({ ok: true, audience: 'tenant', overridesRecommendation: true });
    const resolved = audit.findByMemory(candidate.id).find((e) => e.action === 'hold_resolved')!;
    expect(resolved.details).toMatchObject({ audience: 'tenant', overridesRecommendation: true });
  });

  it('a narrower audience than recommended is always allowed', () => {
    const candidate = seedHeld();
    const result = resolveHold(resolveInput(candidate.id, { audience: 'owner' }), repos());
    expect(result).toMatchObject({ ok: true, audience: 'owner', overridesRecommendation: false });
  });

  it('rejects: retired, receipted, never promoted, row kept', () => {
    const candidate = seedHeld();
    const result = resolveHold(
      resolveInput(candidate.id, { resolution: 'reject', reason: 'not worth keeping' }),
      repos(),
    );
    expect(result).toMatchObject({ ok: true, resolution: 'rejected' });
    expect(statusOf(candidate.id)).toBe('rejected');
    expect(candidates.findById(candidate.id)!.content).toBe(candidate.content);
    expect(memories.count()).toBe(0);
    const events = audit.findByMemory(candidate.id);
    expect(events[1]).toMatchObject({
      action: 'hold_resolved',
      actor: { type: 'human', id: 'jeremy' },
      reason: 'not worth keeping',
      details: { resolution: 'rejected', resolverRole: 'admin' },
    });
    expect(verifyAuditChain(audit).breaks).toEqual([]);
  });

  it('rolls the release back when the hold receipt cannot be written', () => {
    const candidate = seedHeld();
    const insert = audit.insert.bind(audit);
    vi.spyOn(audit, 'insert').mockImplementation((event) => {
      if (event.action === 'hold_resolved') throw new Error('disk full');
      insert(event);
    });
    expect(() => resolveHold(resolveInput(candidate.id), repos())).toThrow('disk full');
    // The memory and its `promoted` receipt went with it: all or nothing.
    expect(memories.count()).toBe(0);
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(actionsFor(candidate.id)).toEqual(['held']);
  });
});

describe('release re-runs the deterministic gate', () => {
  it('refuses a release whose content was promoted in the meantime (duplicate)', () => {
    const candidate = seedHeld();
    // The same content reaches durable memory by another route while it is held.
    const twin = seed(CLEAN);
    candidates.updateContent(twin.id, TENANT, { content: candidate.content, title: twin.title });
    for (const policy of policies.findByTenant(TENANT)) policies.delete(policy.id);
    expect(curator().processSingle(candidates.findById(twin.id)!).outcome).toBe('promoted');
    policies.insert(makePolicy({ rules: RULES }));
    const before = auditCount();

    const result = resolveHold(resolveInput(candidate.id), repos());
    expect(result).toMatchObject({ ok: false, code: 'gate_refused' });
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(memories.count()).toBe(1);
    expect(auditCount()).toBe(before);
  });

  it('refuses a release while a rule the hold does not cover still flags', () => {
    const candidate = seed(`${pii(1)} Notes live in /home/dana/private/notes.md on the box.`);
    const held = curator().processSingle(candidate);
    expect(held.outcome).toBe('held');
    const before = auditCount();

    const result = resolveHold(resolveInput(candidate.id), repos());
    expect(result).toMatchObject({ ok: false, code: 'still_flagged' });
    expect(!result.ok && result.error).toContain('r-sanitize');
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(memories.count()).toBe(0);
    expect(auditCount()).toBe(before);
    // The human can still reject it.
    expect(resolveHold(resolveInput(candidate.id, { resolution: 'reject' }), repos()).ok).toBe(
      true,
    );
  });

  it('refuses a release the disclosure floor rejects, whatever the policy says', () => {
    const candidate = seedHeld();
    // A row whose stored content the disclosure gate would refuse today (a
    // pattern added after capture). Written raw: no governed path can do this.
    const ssnShaped = 'The new hire paperwork lists ' + '078-05-' + '1120 on the tax form.';
    db.prepare('UPDATE candidates SET content = ? WHERE id = ?').run(ssnShaped, candidate.id);
    for (const policy of policies.findByTenant(TENANT)) policies.delete(policy.id);
    const before = auditCount();

    const result = resolveHold(resolveInput(candidate.id), repos());
    expect(result).toMatchObject({ ok: false, code: 'gate_refused' });
    expect(!result.ok && result.error).toContain('disclosure gate');
    expect(memories.count()).toBe(0);
    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(auditCount()).toBe(before);
  });

  it('refuses a release when policy now hard-rejects the content', () => {
    const candidate = seedHeld();
    for (const policy of policies.findByTenant(TENANT)) policies.delete(policy.id);
    policies.insert(
      makePolicy({
        rules: [
          {
            id: 'r-sensitivity-reject',
            type: 'sensitivity_gate',
            action: 'reject',
            enabled: true,
            priority: 0,
            parameters: {},
          },
        ],
      }),
    );
    const result = resolveHold(resolveInput(candidate.id), repos());
    expect(result).toMatchObject({ ok: false, code: 'gate_refused' });
    expect(memories.count()).toBe(0);
    expect(statusOf(candidate.id)).toBe('quarantined');
  });
});

describe('dry-run resolve', () => {
  it('reports what would happen on a READ-ONLY store and writes nothing', () => {
    const candidate = seedHeld();
    db.close();
    const sha = fileSha();
    open(true);

    const release = resolveHold(resolveInput(candidate.id, { dryRun: true }), repos());
    expect(release).toMatchObject({
      ok: true,
      resolution: 'released',
      audience: 'admins',
      auditEventId: null,
      dryRun: true,
    });
    const reject = resolveHold(
      resolveInput(candidate.id, { resolution: 'reject', dryRun: true }),
      repos(),
    );
    expect(reject).toMatchObject({ ok: true, resolution: 'rejected', auditEventId: null });
    const expired = resolveHold(resolveInput(candidate.id, { dryRun: true, now: EXPIRY }), repos());
    expect(expired).toMatchObject({ ok: false, code: 'hold_expired', expiredNow: false });

    expect(statusOf(candidate.id)).toBe('quarantined');
    expect(memories.count()).toBe(0);
    db.close();
    expect(fileSha()).toBe(sha);
    open();
  });
});

describe('curator-cli holds', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const deps: CuratorCliDeps = {
    createDb: ({ dbPath: p, readonly }) =>
      p !== undefined
        ? createDatabase({ path: p, readonly: readonly ?? false })
        : createTestDatabase(),
  };

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  const text = (spy: ReturnType<typeof vi.spyOn>): string =>
    (spy.mock.calls as unknown as Array<[unknown]>).map((c) => String(c[0])).join('');
  const lastJson = (): Record<string, unknown> =>
    JSON.parse(text(stdoutSpy).trim().split('\n').pop()!) as Record<string, unknown>;
  const cli = (action: string, ...rest: string[]): Promise<number> =>
    dispatch(['holds', action, '--db', dbPath, '--tenant', TENANT, ...rest], deps);
  const WHO = ['--actor', 'jeremy', '--reason', 'customer contact'];

  it('lists open holds as JSON without any candidate content', async () => {
    const candidate = seedHeld();
    recommendOnHold(
      {
        candidateId: candidate.id,
        tenantId: TENANT,
        actor: { type: 'ai', id: 'teamkb-review-agent' },
        verdict: 'release',
        audience: 'admins',
        reasoning: 'customer contact',
      },
      repos(),
    );
    expect(await cli('list', '--json')).toBe(0);
    const out = lastJson();
    expect(out).toMatchObject({ ok: true, tenant_id: TENANT, count: 1, max_active: 100 });
    expect((out['holds'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      candidate_id: candidate.id,
      declared_audience: 'tenant',
      recommended_audience: 'admins',
      triggers: ['audience_narrowing_flag', 'sensitivity_gate_flag'],
      expired: false,
      recommendations: [{ actor: 'teamkb-review-agent', actor_type: 'ai', verdict: 'release' }],
    });
    expect(text(stdoutSpy)).not.toContain('dana.whitfield');
  });

  it('lists in plain text', async () => {
    const candidate = seedHeld();
    expect(await cli('list')).toBe(0);
    expect(text(stdoutSpy)).toContain(`Open holds for ${TENANT}: 1 of 100 allowed`);
    expect(text(stdoutSpy)).toContain(candidate.id);
    expect(text(stdoutSpy)).toContain('declared tenant, recommended admins');
  });

  it('resolve --dry-run leaves the store byte-identical', async () => {
    const candidate = seedHeld();
    db.close();
    const sha = fileSha();
    const code = await cli(
      'resolve',
      '--candidate-id',
      candidate.id,
      '--resolution',
      'release',
      '--audience',
      'admins',
      ...WHO,
      '--dry-run',
      '--json',
    );
    expect(code).toBe(0);
    expect(lastJson()).toMatchObject({
      ok: true,
      dry_run: true,
      resolution: 'released',
      audience: 'admins',
      audit_event_id: null,
    });
    expect(fileSha()).toBe(sha);
    open();
    expect(statusOf(candidate.id)).toBe('quarantined');
  });

  it('resolves a release and reports the receipt', async () => {
    const candidate = seedHeld();
    const code = await cli(
      'resolve',
      '--candidate-id',
      candidate.id,
      '--resolution',
      'release',
      '--audience',
      'admins',
      ...WHO,
      '--json',
    );
    expect(code).toBe(0);
    const out = lastJson();
    expect(out).toMatchObject({ ok: true, dry_run: false, resolution: 'released' });
    expect(statusOf(candidate.id)).toBe('promoted');
    const memory = memories.findById(String(out['memory_id']))!;
    expect(memory.metadata.audience).toBe('admins');
    const resolved = audit.findByMemory(candidate.id).find((e) => e.action === 'hold_resolved')!;
    expect(resolved.id).toBe(out['audit_event_id']);
    expect(resolved.actor).toEqual({ type: 'human', id: 'jeremy' });
    expect(verifyAuditChain(audit).breaks).toEqual([]);
  });

  it('exits 3 when the resolution is refused: a member, and a wider audience', async () => {
    const candidate = seedHeld();
    const base = ['--candidate-id', candidate.id, '--resolution', 'release', ...WHO];
    expect(await cli('resolve', ...base, '--audience', 'admins', '--role', 'member')).toBe(3);
    expect(text(stdoutSpy)).toContain('[forbidden_role]');
    expect(await cli('resolve', ...base, '--audience', 'tenant', '--json')).toBe(3);
    expect(lastJson()).toMatchObject({ ok: false, code: 'wider_than_recommended' });
    expect(statusOf(candidate.id)).toBe('quarantined');

    expect(await cli('resolve', ...base, '--audience', 'tenant', '--acknowledge-wider')).toBe(0);
    expect(statusOf(candidate.id)).toBe('promoted');
  });

  it('rejects from the CLI', async () => {
    const candidate = seedHeld();
    expect(
      await cli('resolve', '--candidate-id', candidate.id, '--resolution', 'reject', ...WHO),
    ).toBe(0);
    expect(text(stdoutSpy)).toContain('rejected');
    expect(statusOf(candidate.id)).toBe('rejected');
  });

  it('expire closes nothing while holds are inside their bound', async () => {
    const candidate = seed(pii(1));
    // Held against the wall clock, so the 14-day bound has not elapsed.
    new Curator(repos(), { tenantId: TENANT }).processSingle(candidate);
    expect(await cli('expire', '--dry-run', '--json')).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, dry_run: true, expired: 0 });
    expect(await cli('expire')).toBe(0);
    expect(text(stdoutSpy)).toContain('Expired: 0 (none promoted)');
    expect(statusOf(candidate.id)).toBe('quarantined');
  });

  it('expire closes a hold past its bound, unpromoted', async () => {
    // Held at T0 (2026-10-04) with a 14-day bound: long past by the wall clock.
    const candidate = seed(pii(1));
    curator({ now: () => '2020-01-01T00:00:00.000Z' }).processSingle(candidate);
    expect(await cli('list', '--json')).toBe(0);
    expect(lastJson()).toMatchObject({ count: 1, expired: 1 });
    expect(await cli('expire', '--json')).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, expired: 1 });
    expect(statusOf(candidate.id)).toBe('rejected');
    expect(memories.count()).toBe(0);
  });

  it('reports usage errors with exit 2', async () => {
    expect(await dispatch(['holds'], deps)).toBe(2);
    expect(await dispatch(['holds', 'approve'], deps)).toBe(2);
    expect(await cli('resolve', '--resolution', 'release')).toBe(2);
    expect(await cli('list', '--bogus')).toBe(2);
    expect(
      await cli('resolve', '--candidate-id', 'not-a-uuid', '--resolution', 'reject', ...WHO),
    ).toBe(2);
    expect(text(stderrSpy)).toContain('Usage: curator-cli holds');
  });

  it('exits 1 when the store cannot be opened', async () => {
    const failing: CuratorCliDeps = {
      createDb: () => {
        throw new Error('unable to open database file');
      },
    };
    expect(await dispatch(['holds', 'list', '--db', '/nope', '--tenant', TENANT], failing)).toBe(1);
    expect(text(stderrSpy)).toContain('holds list failed');
  });
});
