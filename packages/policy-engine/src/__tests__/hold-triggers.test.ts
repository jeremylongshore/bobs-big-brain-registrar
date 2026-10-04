/**
 * Human-escalation hold triggers (Epic K bead K6): the pure decision "does this
 * candidate go on hold?", plus the escalation rate measured on the K3
 * hand-labeled audience fixture. The rate is reported on its own and is not
 * blended into the `audience_narrowing` precision / recall (KR8.2).
 */
import { describe, it, expect } from 'vitest';
import { scanDisclosureFields } from '@qmd-team-intent-kb/common';
import { GovernancePolicy } from '@qmd-team-intent-kb/schema';
import {
  HOLD_TRIGGER_RULE_TYPES,
  evaluateHoldTriggers,
  isAudienceAboveProposerClearance,
  unresolvedFlagsAfterRelease,
} from '../hold/hold-triggers.js';
import { measureHoldEscalation } from '../hold/hold-escalation.js';
import { PolicyPipeline } from '../pipeline.js';
import { buildRecommendedPolicy } from '../recommended-policy.js';
import type { PipelineResult } from '../types.js';
import { makeCandidate, FIXED_NOW, DEFAULT_TENANT } from './fixtures.js';
import { AUDIENCE_NARROWING_CASES } from './fixtures/audience-narrowing-labeled.js';

const PII = 'Escalate billing questions to dana.whitfield@customer-example.com before Friday.';
const CLEAN = 'Use dependency injection for all services in the codebase, without exception.';
const ENV_SECRET = 'DEPLOY_' + 'PASSWORD=' + 'correct-horse-battery';

function candidateFor(content: string, metadata: Record<string, unknown> = {}) {
  return makeCandidate({ content, metadata: { filePaths: [], tags: [], ...metadata } });
}

function policyWith(rules: Array<Record<string, unknown>>): GovernancePolicy {
  return GovernancePolicy.parse({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'hold test policy',
    tenantId: DEFAULT_TENANT,
    rules: rules.map((r, i) => ({ enabled: true, priority: i, parameters: {}, ...r })),
    enabled: true,
    version: 1,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  });
}

const AUDIENCE_RULE = { id: 'r-audience', type: 'audience_narrowing', action: 'flag' };

function decide(content: string, policy: GovernancePolicy, metadata?: Record<string, unknown>) {
  const candidate = candidateFor(content, metadata);
  const result = new PolicyPipeline(policy).evaluate(candidate, {
    existingHashes: new Set<string>(),
    tenantId: DEFAULT_TENANT,
  });
  return { candidate, result, decision: evaluateHoldTriggers(candidate, result, policy) };
}

const APPROVED: PipelineResult = { candidateId: 'c', outcome: 'approved', evaluations: [] };

describe('evaluateHoldTriggers', () => {
  it('holds nothing when no trigger fires', () => {
    expect(decide(CLEAN, policyWith([AUDIENCE_RULE])).decision).toBeNull();
  });

  it('holds a candidate the audience_narrowing rule flags and recommends the narrower tier', () => {
    const { decision } = decide(PII, policyWith([AUDIENCE_RULE]));
    expect(decision).toMatchObject({
      triggers: ['audience_narrowing_flag'],
      declaredAudience: 'tenant',
      recommendedAudience: 'admins',
      basis: 'pii',
      triggerRuleIds: ['r-audience'],
      otherFlags: [],
    });
    expect(decision?.matchedPatterns.length).toBeGreaterThan(0);
  });

  it('never carries candidate content in the decision', () => {
    const { decision } = decide(PII, policyWith([AUDIENCE_RULE]));
    expect(JSON.stringify(decision)).not.toContain('dana.whitfield');
  });

  it('never softens a hard reject into a hold', () => {
    const policy = policyWith([
      { id: 'r-secret', type: 'secret_detection', action: 'reject' },
      AUDIENCE_RULE,
    ]);
    const { result, decision } = decide(`The deploy step reads ${ENV_SECRET} at boot.`, policy);
    expect(result.outcome).toBe('rejected');
    expect(decision).toBeNull();
  });

  it('holds when a secret scan fires under a flag action (the ambiguous case)', () => {
    const policy = policyWith([{ id: 'r-secret', type: 'secret_detection', action: 'flag' }]);
    const { result, decision } = decide(`The deploy step reads ${ENV_SECRET} at boot.`, policy);
    expect(result.outcome).toBe('flagged');
    expect(decision?.triggers).toEqual(['secret_scan_flag']);
    expect(decision?.recommendedAudience).toBe('owner');
  });

  it('holds when the sensitivity gate flags, even at an audience already narrow enough', () => {
    const policy = policyWith([
      { id: 'r-sensitivity', type: 'sensitivity_gate', action: 'flag' },
      AUDIENCE_RULE,
    ]);
    const { decision } = decide(PII, policy, { audience: 'admins' });
    expect(decision?.triggers).toEqual(['sensitivity_gate_flag']);
    expect(decision?.recommendedAudience).toBe('admins');
  });

  it('reports flags from rules a hold does not cover separately', () => {
    const policy = policyWith([
      AUDIENCE_RULE,
      { id: 'r-sanitize', type: 'content_sanitization', action: 'flag' },
    ]);
    const { decision, result } = decide(`${PII} See /home/dana/private/notes.md.`, policy);
    expect(decision?.triggers).toEqual(['audience_narrowing_flag']);
    expect(decision?.otherFlags).toEqual(['r-sanitize']);
    expect(unresolvedFlagsAfterRelease(result)).toEqual(['r-sanitize']);
  });

  it('a release resolves exactly the flags the hold covers', () => {
    const policy = policyWith([
      { id: 'r-sensitivity', type: 'sensitivity_gate', action: 'flag' },
      AUDIENCE_RULE,
    ]);
    const { result } = decide(PII, policy);
    expect(result.flaggedBy).toEqual(['r-sensitivity', 'r-audience']);
    expect(unresolvedFlagsAfterRelease(result)).toEqual([]);
    expect(HOLD_TRIGGER_RULE_TYPES).toEqual([
      'audience_narrowing',
      'secret_detection',
      'sensitivity_gate',
    ]);
  });

  it('keeps the recommendation at the declared tier when that is already narrower', () => {
    const policy = policyWith([{ id: 'r-sensitivity', type: 'sensitivity_gate', action: 'flag' }]);
    expect(decide(PII, policy, { audience: 'owner' }).decision?.recommendedAudience).toBe('owner');
  });
});

describe('proposer clearance trigger', () => {
  it('holds a member proposal that declares an audience members cannot read', () => {
    for (const audience of ['admins', 'owner']) {
      const candidate = candidateFor(CLEAN, { audience, proposedByRole: 'member' });
      expect(isAudienceAboveProposerClearance(candidate)).toBe(true);
      expect(evaluateHoldTriggers(candidate, APPROVED)).toMatchObject({
        triggers: ['audience_above_proposer_clearance'],
        recommendedAudience: audience,
        triggerRuleIds: [],
      });
    }
  });

  it('fires with no policy at all (it is structural)', () => {
    const candidate = candidateFor(CLEAN, { audience: 'admins', proposedByRole: 'member' });
    expect(evaluateHoldTriggers(candidate, APPROVED, undefined)).not.toBeNull();
  });

  it('does not hold a member proposal at the tenant-wide default', () => {
    const candidate = candidateFor(CLEAN, { proposedByRole: 'member' });
    expect(evaluateHoldTriggers(candidate, APPROVED)).toBeNull();
  });

  it('does not hold an admin-stamped proposal: the stamp cannot tell an admin from the owner', () => {
    for (const audience of ['tenant', 'admins', 'owner']) {
      const candidate = candidateFor(CLEAN, { audience, proposedByRole: 'admin' });
      expect(isAudienceAboveProposerClearance(candidate)).toBe(false);
    }
  });

  it('does not hold a local capture with no stamped role', () => {
    const candidate = candidateFor(CLEAN, { audience: 'owner' });
    expect(evaluateHoldTriggers(candidate, APPROVED)).toBeNull();
  });
});

/**
 * KR8.5 measurement — how often the hold triggers on the K3 hand-labeled
 * audience fixture, through the RECOMMENDED policy (the shape a governed store
 * runs). Counts are pinned so a change in the escalation rate is a visible diff.
 */
describe('hold escalation rate on the K3 hand-labeled audience fixture', () => {
  const policy = buildRecommendedPolicy(DEFAULT_TENANT, FIXED_NOW);
  const candidates = AUDIENCE_NARROWING_CASES.map((c) =>
    makeCandidate({
      content: c.content,
      metadata:
        c.declared === undefined
          ? { filePaths: [], tags: [] }
          : { filePaths: [], tags: [], audience: c.declared },
    }),
  );
  const report = measureHoldEscalation(candidates, policy);
  const heldCases = AUDIENCE_NARROWING_CASES.filter((_, i) =>
    report.heldIds.includes(candidates[i]!.id),
  );
  // A held case whose content the store's disclosure choke point refuses can
  // never be stored as a candidate, so in practice it never reaches a hold.
  const storable = heldCases.filter((c) => scanDisclosureFields([c.content]) === null);

  it('reports the measured counts', () => {
    console.info(
      `[hold escalation / K3 fixture] cases=${report.total} held=${report.held} ` +
        `rate=${report.escalationRate.toFixed(3)} rejected=${report.rejected} ` +
        `flagged_other=${report.flaggedOther} approved=${report.approved} ` +
        `held_and_storable=${storable.length} by_trigger=${JSON.stringify(report.byTrigger)}`,
    );
    expect(report.held + report.rejected + report.flaggedOther + report.approved).toBe(
      AUDIENCE_NARROWING_CASES.length,
    );
  });

  it('pins the escalation rate: 9 of 29 cases are held', () => {
    expect(report.total).toBe(29);
    expect(report).toMatchObject({ held: 9, rejected: 11, flaggedOther: 1, approved: 8 });
    expect(report.byTrigger).toEqual({ audience_narrowing_flag: 6, sensitivity_gate_flag: 9 });
    expect(storable.length).toBe(6);
  });

  it('holds exactly the cases a person has to look at', () => {
    expect(heldCases.map((c) => c.id).sort()).toEqual([
      'neg-email-already-admins',
      'neg-email-already-owner',
      'neg-phone-already-admins',
      'neg-ten-digit-build-number',
      'pos-background-check-tenant',
      'pos-date-of-birth-default',
      'pos-personal-email-tenant',
      'pos-phone-default',
      'pos-ssn-shape-tenant',
    ]);
  });

  it('never holds a case the pipeline hard-rejects or approves clean', () => {
    const held = new Set(heldCases.map((c) => c.id));
    expect(held.has('pos-aws-key-tenant')).toBe(false);
    expect(held.has('neg-plain-convention')).toBe(false);
  });
});
