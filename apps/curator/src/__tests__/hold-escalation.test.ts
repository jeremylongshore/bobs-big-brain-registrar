import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createDatabase,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeCandidate, TENANT } from './fixtures.js';
import {
  placeHold,
  recommendOnHold,
  expireHolds,
  expireHold,
  findActiveHold,
} from '../hold/hold.js';
import { resolveHold } from '../hold/resolve-hold.js';
import {
  beginHoldEscalation,
  completeHoldEscalation,
  planHoldEscalations,
} from '../hold/escalation.js';

const START = '2026-01-01T00:00:00.000Z';
const WARNING = '2026-01-02T00:00:00.000Z';
const EXPIRY = '2026-01-03T00:00:00.000Z';
let root: string;
let db: ReturnType<typeof createDatabase>;
let repos: {
  candidateRepo: CandidateRepository;
  memoryRepo: MemoryRepository;
  auditRepo: AuditRepository;
  policyRepo: PolicyRepository;
};
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hold-escalation-'));
  db = createDatabase({ path: join(root, 'fixture.db') });
  repos = {
    candidateRepo: new CandidateRepository(db),
    memoryRepo: new MemoryRepository(db),
    auditRepo: new AuditRepository(db),
    policyRepo: new PolicyRepository(db),
  };
  const candidate = makeCandidate({
    title: 'Private lesson title',
    content: 'Private held lesson body must never appear in an escalation.',
  });
  id = candidate.id;
  repos.candidateRepo.insert(candidate, computeContentHash(candidate.content));
  placeHold(
    candidate,
    {
      triggers: ['sensitivity_gate_flag'],
      declaredAudience: 'tenant',
      recommendedAudience: 'admins',
      basis: 'pii',
      matchedPatterns: [],
      triggerRuleIds: [],
      otherFlags: [],
    },
    repos,
    { now: START, limits: { ttlDays: 2 } },
  );
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function state() {
  return {
    rows: db.prepare('SELECT * FROM candidates ORDER BY id').all(),
    events: repos.auditRepo.findAllChronological(),
  };
}
function recommend() {
  expect(
    recommendOnHold(
      {
        candidateId: id,
        tenantId: TENANT,
        actor: { type: 'human', id: 'reviewer' },
        verdict: 'release',
        reasoning: 'Private recommendation reasoning',
        now: START,
      },
      repos,
    ).ok,
  ).toBe(true);
}
function final(outcome: 'delivered' | 'failed' | 'unknown' = 'delivered') {
  const plan = planHoldEscalations(TENANT, repos, EXPIRY)[0]!;
  beginHoldEscalation(plan, repos, EXPIRY);
  return completeHoldEscalation(
    {
      candidateId: id,
      tenantId: TENANT,
      attemptId: plan.attemptId,
      snapshotDigest: plan.snapshotDigest,
      outcome,
    },
    repos,
    EXPIRY,
  );
}

describe('durable hold expiry escalation', () => {
  it('refuses altered transport bindings and receipt digests without changing durable evidence', () => {
    const plan = planHoldEscalations(TENANT, repos, EXPIRY)[0]!;
    const binding = 'a'.repeat(64);
    beginHoldEscalation(plan, repos, EXPIRY, binding);
    const intentState = state();
    expect(() => beginHoldEscalation(plan, repos, EXPIRY)).toThrow();
    expect(() => beginHoldEscalation(plan, repos, EXPIRY, 'b'.repeat(64))).toThrow();
    const input = {
      candidateId: id,
      tenantId: TENANT,
      attemptId: plan.attemptId,
      snapshotDigest: plan.snapshotDigest,
      outcome: 'delivered' as const,
      transportBinding: binding,
      transportReceiptDigest: 'c'.repeat(64),
    };
    expect(() =>
      completeHoldEscalation({ ...input, transportBinding: 'b'.repeat(64) }, repos, EXPIRY),
    ).toThrow();
    expect(state()).toEqual(intentState);
    const receipt = completeHoldEscalation(input, repos, EXPIRY);
    const completedState = state();
    expect(completeHoldEscalation(input, repos, EXPIRY)).toBe(receipt);
    expect(() =>
      completeHoldEscalation({ ...input, transportReceiptDigest: 'd'.repeat(64) }, repos, EXPIRY),
    ).toThrow();
    expect(state()).toEqual(completedState);
  });

  it('plans exactly at 24h, isolates tenants, never exposes content, and writes nothing', () => {
    const before = state();
    expect(planHoldEscalations(TENANT, repos, '2026-01-01T23:59:59.999Z')).toEqual([]);
    const plans = planHoldEscalations(TENANT, repos, WARNING);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ phase: 'warning', remainingMs: 86400000 });
    expect(planHoldEscalations(TENANT, repos, EXPIRY)[0]).toMatchObject({
      phase: 'final',
      remainingMs: 0,
    });
    expect(planHoldEscalations('other', repos, WARNING)).toEqual([]);
    expect(JSON.stringify(plans)).not.toContain('Private');
    expect(state()).toEqual(before);
  });
  it('refuses premature or foreign intent and replays an identical intent once', () => {
    const plan = planHoldEscalations(TENANT, repos, WARNING)[0]!;
    expect(() => beginHoldEscalation(plan, repos, START)).toThrow();
    expect(() => beginHoldEscalation({ ...plan, tenantId: 'other' }, repos, WARNING)).toThrow();
    expect(beginHoldEscalation(plan, repos, WARNING).alreadyStarted).toBe(false);
    const before = state();
    expect(beginHoldEscalation(plan, repos, WARNING).alreadyStarted).toBe(true);
    expect(state()).toEqual(before);
  });
  it('does not close release-advised holds through batch, direct or human resolve without final outcome', () => {
    recommend();
    const hold = findActiveHold(id, TENANT, repos, EXPIRY)!;
    const before = state();
    expect(expireHolds(TENANT, repos, { now: EXPIRY, dryRun: true })[0]).toMatchObject({
      escalationRequired: true,
      auditEventId: null,
    });
    expect(expireHolds(TENANT, repos, { now: EXPIRY })[0]).toMatchObject({
      escalationRequired: true,
      auditEventId: null,
    });
    expect(expireHold(hold, repos, EXPIRY)).toBeNull();
    expect(
      resolveHold(
        {
          candidateId: id,
          tenantId: TENANT,
          resolution: 'release',
          audience: 'admins',
          role: 'owner',
          actor: { type: 'human', id: 'reviewer' },
          reason: 'review',
          now: EXPIRY,
        },
        repos,
      ),
    ).toMatchObject({ ok: false, code: 'hold_expired', expiredNow: false });
    expect(state()).toEqual(before);
    expect(repos.memoryRepo.count()).toBe(0);
  });
  it('an old warning and a started final attempt do not authorize expiry', () => {
    recommend();
    const warning = planHoldEscalations(TENANT, repos, WARNING)[0]!;
    beginHoldEscalation(warning, repos, WARNING);
    completeHoldEscalation(
      {
        candidateId: id,
        tenantId: TENANT,
        attemptId: warning.attemptId,
        snapshotDigest: warning.snapshotDigest,
        outcome: 'delivered',
      },
      repos,
      WARNING,
    );
    expect(expireHolds(TENANT, repos, { now: EXPIRY })[0]?.escalationRequired).toBe(true);
    beginHoldEscalation(planHoldEscalations(TENANT, repos, EXPIRY)[0]!, repos, EXPIRY);
    expect(expireHolds(TENANT, repos, { now: EXPIRY })[0]?.escalationRequired).toBe(true);
  });
  it.each(['delivered', 'failed', 'unknown'] as const)(
    'records %s honestly and names the lost proposal without its text',
    (outcome) => {
      recommend();
      const receipt = final(outcome);
      const result = expireHolds(TENANT, repos, { now: EXPIRY });
      expect(result[0]?.auditEventId).toBeTruthy();
      expect(repos.candidateRepo.findById(id)?.status).toBe('rejected');
      expect(repos.memoryRepo.count()).toBe(0);
      const events = repos.auditRepo.findByMemory(id);
      const loss = events.find((event) => event.action === 'hold_resolved')!;
      expect(loss.details).toMatchObject({
        candidateId: id,
        finalEscalationReceiptId: receipt,
        resolution: 'expired',
      });
      expect(loss.details['contentDigest']).toMatch(/^[0-9a-f]{64}$/);
      expect(loss.details['unreleasedReleaseRecommendationIds']).toHaveLength(1);
      expect(
        JSON.stringify(events.filter((event) => event.action !== 'hold_recommended')),
      ).not.toContain('Private');
      expect(events.find((event) => event.id === receipt)?.details['outcome']).toBe(outcome);
      expect(verifyAuditChain(repos.auditRepo).breaks).toEqual([]);
      expect(expireHolds(TENANT, repos, { now: EXPIRY })).toEqual([]);
    },
  );
  it('replays the same completion and refuses a conflicting or foreign outcome', () => {
    const plan = planHoldEscalations(TENANT, repos, EXPIRY)[0]!;
    const input = {
      candidateId: id,
      tenantId: TENANT,
      attemptId: plan.attemptId,
      snapshotDigest: plan.snapshotDigest,
      outcome: 'unknown' as const,
    };
    expect(() => completeHoldEscalation(input, repos, EXPIRY)).toThrow();
    beginHoldEscalation(plan, repos, EXPIRY);
    const receipt = completeHoldEscalation(input, repos, EXPIRY);
    const before = state();
    expect(completeHoldEscalation(input, repos, EXPIRY)).toBe(receipt);
    expect(() =>
      completeHoldEscalation({ ...input, outcome: 'delivered' }, repos, EXPIRY),
    ).toThrow();
    expect(() => completeHoldEscalation({ ...input, tenantId: 'other' }, repos, EXPIRY)).toThrow();
    expect(state()).toEqual(before);
  });
  it('refuses a stale result and requires a new final attempt after stored content changes', () => {
    recommend();
    const plan = planHoldEscalations(TENANT, repos, EXPIRY)[0]!;
    final();
    db.prepare("UPDATE candidates SET title='changed private title' WHERE id=?").run(id);
    expect(() =>
      completeHoldEscalation(
        {
          candidateId: id,
          tenantId: TENANT,
          attemptId: plan.attemptId,
          snapshotDigest: plan.snapshotDigest,
          outcome: 'delivered',
        },
        repos,
        EXPIRY,
      ),
    ).toThrow();
    expect(expireHolds(TENANT, repos, { now: EXPIRY })[0]?.escalationRequired).toBe(true);
    final();
    expect(expireHolds(TENANT, repos, { now: EXPIRY })[0]?.auditEventId).toBeTruthy();
  });
  it.each(['IGNORE', "ABORT, 'fixture'"])(
    'rolls back rejection if the loss receipt cannot be written (%s)',
    (refusal) => {
      recommend();
      final();
      db.exec(
        `CREATE TRIGGER refuse_loss BEFORE INSERT ON audit_events WHEN NEW.action='hold_resolved' BEGIN SELECT RAISE(${refusal}); END`,
      );
      const before = state();
      expect(() => expireHolds(TENANT, repos, { now: EXPIRY })).toThrow();
      expect(state()).toEqual(before);
      db.exec('DROP TRIGGER refuse_loss');
      expect(expireHolds(TENANT, repos, { now: EXPIRY })[0]?.auditEventId).toBeTruthy();
    },
  );
  it.each(['IGNORE', "ABORT, 'fixture'"])(
    'refuses an ignored or failed escalation receipt (%s)',
    (refusal) => {
      const plan = planHoldEscalations(TENANT, repos, EXPIRY)[0]!;
      db.exec(
        `CREATE TRIGGER refuse_escalation BEFORE INSERT ON audit_events WHEN NEW.action='hold_escalated' BEGIN SELECT RAISE(${refusal}); END`,
      );
      const before = state();
      expect(() => beginHoldEscalation(plan, repos, EXPIRY)).toThrow();
      expect(state()).toEqual(before);
      db.exec('DROP TRIGGER refuse_escalation');
      beginHoldEscalation(plan, repos, EXPIRY);
      db.exec(
        `CREATE TRIGGER refuse_escalation BEFORE INSERT ON audit_events WHEN NEW.action='hold_escalated' BEGIN SELECT RAISE(${refusal}); END`,
      );
      const started = state();
      expect(() =>
        completeHoldEscalation(
          {
            candidateId: id,
            tenantId: TENANT,
            attemptId: plan.attemptId,
            snapshotDigest: plan.snapshotDigest,
            outcome: 'failed',
          },
          repos,
          EXPIRY,
        ),
      ).toThrow();
      expect(state()).toEqual(started);
    },
  );
  it('refuses an altered intent instead of returning successful replay', () => {
    const plan = planHoldEscalations(TENANT, repos, EXPIRY)[0]!;
    beginHoldEscalation(plan, repos, EXPIRY);
    db.prepare("UPDATE audit_events SET reason='changed' WHERE id=?").run(plan.attemptId);
    const before = state();
    expect(() => beginHoldEscalation(plan, repos, EXPIRY)).toThrow();
    expect(() =>
      completeHoldEscalation(
        {
          candidateId: id,
          tenantId: TENANT,
          attemptId: plan.attemptId,
          snapshotDigest: plan.snapshotDigest,
          outcome: 'delivered',
        },
        repos,
        EXPIRY,
      ),
    ).toThrow();
    expect(state()).toEqual(before);
  });
  it('does not accept future final outcomes as current expiry authority', () => {
    recommend();
    const plan = planHoldEscalations(TENANT, repos, EXPIRY)[0]!;
    beginHoldEscalation(plan, repos, EXPIRY);
    completeHoldEscalation(
      {
        candidateId: id,
        tenantId: TENANT,
        attemptId: plan.attemptId,
        snapshotDigest: plan.snapshotDigest,
        outcome: 'delivered',
      },
      repos,
      '2026-01-03T00:01:00.000Z',
    );
    expect(expireHolds(TENANT, repos, { now: EXPIRY })[0]?.escalationRequired).toBe(true);
  });
  it('direct expiry rechecks current time and does not trust a stale caller hold object', () => {
    const hold = findActiveHold(id, TENANT, repos, EXPIRY)!;
    const before = state();
    expect(() => expireHold(hold, repos, START)).toThrow();
    expect(state()).toEqual(before);
  });
});
