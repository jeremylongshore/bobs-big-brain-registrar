/**
 * Human-escalation HOLD triggers (Epic K bead K6, decision `000-docs/053-AT-DECR`).
 *
 * Some audience and secret questions the deterministic pipeline can DETECT but
 * cannot DECIDE: the content looks like it belongs to a narrower audience than
 * it declares, the proposer is not cleared for the audience they declared, or a
 * secret scan or the sensitivity gate fired under a policy that flags rather
 * than rejects. Before K6 a
 * candidate in that position was left in the inbox indefinitely with no exit.
 * This module is the pure decision "does this candidate go on hold?". It reads
 * a candidate and the pipeline result and returns the triggers; it writes
 * nothing. The state change belongs to the curator (`apps/curator/src/hold/`).
 *
 * Placement (KR8.1 / 014-AT-DECR): the hold is entered by a deterministic rule
 * outcome only. Nothing here takes a model's opinion as input, so nothing a
 * model emits can put a candidate on hold or take it off.
 *
 * @module hold/hold-triggers
 */

import {
  AUDIENCE_RANK,
  READER_ROLE_CLEARANCE,
  isAudienceVisibleToRole,
  resolveAudience,
} from '@qmd-team-intent-kb/common';
import type { GovernancePolicy, MemoryCandidate } from '@qmd-team-intent-kb/schema';

import { recommendAudience } from '../rules/audience-narrowing-rule.js';
import type { AudienceRecommendationBasis } from '../rules/audience-narrowing-rule.js';
import type { PipelineResult } from '../types.js';

/** Why a candidate is put on hold. */
export type HoldTrigger =
  /** The `audience_narrowing` rule flagged: declared audience wider than the content calls for. */
  | 'audience_narrowing_flag'
  /** The candidate declares an audience its proposer is not cleared to read. */
  | 'audience_above_proposer_clearance'
  /** A `secret_detection` rule fired under a non-reject action (flag / require_review). */
  | 'secret_scan_flag'
  /**
   * The `sensitivity_gate` rule fired under a non-reject action: the content
   * classifies as credentials or PII. Whether it may be promoted, and for whom,
   * is the same audience question — even when the declared audience already
   * matches the recommendation.
   */
  | 'sensitivity_gate_flag';

/** Rule types whose flags a hold covers, and a human release resolves. */
export const HOLD_TRIGGER_RULE_TYPES: readonly string[] = Object.freeze([
  'audience_narrowing',
  'secret_detection',
  'sensitivity_gate',
]);

/** The trigger each covered rule type raises when it does not pass. */
const TRIGGER_BY_RULE_TYPE: Readonly<Record<string, HoldTrigger>> = Object.freeze({
  audience_narrowing: 'audience_narrowing_flag',
  secret_detection: 'secret_scan_flag',
  sensitivity_gate: 'sensitivity_gate_flag',
});

/** The narrowest audience tier: the fail-closed recommendation for an unknown tier. */
const NARROWEST_AUDIENCE = 'owner';

/** The deterministic decision to hold one candidate. */
export interface HoldDecision {
  /** Why it is held. Non-empty, sorted, de-duplicated. */
  triggers: HoldTrigger[];
  /** The audience the candidate effectively declares (absent -> `tenant`). */
  declaredAudience: string;
  /**
   * The audience a release takes without an explicit override: the narrower of
   * the declared tier and the tier the content classification supports.
   */
  recommendedAudience: string;
  /** Which content class drove the recommendation. */
  basis: AudienceRecommendationBasis;
  /** Pattern IDS that fired. Never the matched text. */
  matchedPatterns: string[];
  /** Ids of the rules whose flags this hold covers. */
  triggerRuleIds: string[];
  /** Ids of rules that flagged for a reason a hold does NOT cover. */
  otherFlags: string[];
}

function rank(audience: string): number | undefined {
  return Object.hasOwn(AUDIENCE_RANK, audience) ? AUDIENCE_RANK[audience] : undefined;
}

/** The narrower of two tiers; an unknown tier resolves to the narrowest (fail closed). */
function narrower(a: string, b: string): string {
  const ra = rank(a);
  const rb = rank(b);
  if (ra === undefined || rb === undefined) return NARROWEST_AUDIENCE;
  return ra >= rb ? a : b;
}

/**
 * True when the proposer's stamped role is PROVABLY not cleared to read the
 * audience the candidate declares. Only a server-stamped role
 * (`metadata.proposedByRole`) is judged: a candidate with no stamped role is a
 * local or legacy capture by the person at the keyboard, and is treated as
 * cleared.
 *
 * The stamp records `admin` or `member`. It does not record owner standing, so
 * an `admin` stamp may be the owner's and is given owner clearance here: a hold
 * needs a gap the stamp can prove, and the owner declaring `owner` is the
 * ordinary K2 flow. In practice this fires for a `member` declaring `admins` or
 * `owner`. An unrecognized role or audience is held (fail closed).
 */
export function isAudienceAboveProposerClearance(candidate: MemoryCandidate): boolean {
  const role = candidate.metadata.proposedByRole;
  if (role === undefined) return false;
  if (!Object.hasOwn(READER_ROLE_CLEARANCE, role)) return true;
  return !isAudienceVisibleToRole(candidate.metadata.audience, role === 'admin' ? 'owner' : role);
}

/**
 * Decide whether a candidate goes on hold. Pure and deterministic.
 *
 * Returns `null` when no trigger fires, and also when the pipeline REJECTED the
 * candidate: a hard reject is a decision, not an ambiguity, so it is never
 * softened into a hold.
 *
 * @param candidate       The candidate, as captured.
 * @param pipelineResult  The policy pipeline's result for it.
 * @param policy          The policy that produced the result, when there is one.
 *                        Used only to read the `audience_narrowing` rule's tier
 *                        parameters so the recommendation matches the rule.
 */
export function evaluateHoldTriggers(
  candidate: MemoryCandidate,
  pipelineResult: PipelineResult,
  policy?: GovernancePolicy,
): HoldDecision | null {
  if (pipelineResult.outcome === 'rejected') return null;

  const triggers = new Set<HoldTrigger>();
  const triggerRuleIds: string[] = [];
  for (const evaluation of pipelineResult.evaluations) {
    // A covered rule that did not pass. Reached only under a non-reject action:
    // a rejecting rule short-circuits the pipeline to `rejected`, which
    // returned null above.
    const trigger = Object.hasOwn(TRIGGER_BY_RULE_TYPE, evaluation.ruleType)
      ? TRIGGER_BY_RULE_TYPE[evaluation.ruleType]
      : undefined;
    if (trigger !== undefined && evaluation.outcome !== 'pass') {
      triggers.add(trigger);
      triggerRuleIds.push(evaluation.ruleId);
    }
  }
  if (isAudienceAboveProposerClearance(candidate)) {
    triggers.add('audience_above_proposer_clearance');
  }
  if (triggers.size === 0) return null;

  const declaredAudience = resolveAudience(candidate.metadata.audience);
  const narrowingRule = policy?.rules.find((r) => r.enabled && r.type === 'audience_narrowing');
  const recommendation = recommendAudience(candidate.content, declaredAudience, {
    credentials: narrowingRule?.parameters['credentialsAudience'],
    pii: narrowingRule?.parameters['piiAudience'],
  });

  return {
    triggers: [...triggers].sort((a, b) => a.localeCompare(b)),
    declaredAudience,
    recommendedAudience: narrower(declaredAudience, recommendation.recommended),
    basis: recommendation.basis,
    matchedPatterns: recommendation.matchedPatterns,
    triggerRuleIds,
    otherFlags: (pipelineResult.flaggedBy ?? []).filter((id) => !triggerRuleIds.includes(id)),
  };
}

/**
 * The flags left once a human has released a hold: every flag from a rule a
 * hold does not cover. A release resolves the audience, secret-scan and
 * sensitivity flags (that is the question the human answered); it resolves
 * nothing else, so a contradiction or sanitization flag still stops the promotion.
 */
export function unresolvedFlagsAfterRelease(pipelineResult: PipelineResult): string[] {
  const covered = new Set(
    pipelineResult.evaluations
      .filter((e) => HOLD_TRIGGER_RULE_TYPES.includes(e.ruleType) && e.outcome !== 'pass')
      .map((e) => e.ruleId),
  );
  return (pipelineResult.flaggedBy ?? []).filter((id) => !covered.has(id));
}
