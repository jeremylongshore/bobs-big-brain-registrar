/**
 * Escalation-rate measurement for the human-escalation hold (Epic K bead K6).
 *
 * How often does the hold trigger? A hold costs a person's attention, so the
 * rate is measured on its own, over hand-labeled fixtures, and is never blended
 * into the disclosure or audience-rule precision / recall numbers.
 *
 * @module hold/hold-escalation
 */

import type { GovernancePolicy, MemoryCandidate } from '@qmd-team-intent-kb/schema';

import { PolicyPipeline } from '../pipeline.js';
import { evaluateHoldTriggers } from './hold-triggers.js';
import type { HoldTrigger } from './hold-triggers.js';

/** What the govern decision did with every candidate of one fixture. */
export interface HoldEscalationReport {
  total: number;
  /** Hard-rejected by a rule: a decision, never a hold. */
  rejected: number;
  /** Put on a human-escalation hold. */
  held: number;
  /** Flagged only by rules a hold does not cover (left for the existing review path). */
  flaggedOther: number;
  /** Approved outright. */
  approved: number;
  /** `held / total`. */
  escalationRate: number;
  /** How many held candidates each trigger fired on (a candidate may carry several). */
  byTrigger: Partial<Record<HoldTrigger, number>>;
  /** Ids of the held candidates, in input order. */
  heldIds: string[];
}

/**
 * Run each candidate through `policy` and count the outcomes. Pure and
 * deterministic: the same pipeline and the same trigger decision the curator
 * uses, with no store (so `dedup_check` and `contradiction_check` pass
 * vacuously, as they do for a first capture into an empty brain).
 */
export function measureHoldEscalation(
  candidates: readonly MemoryCandidate[],
  policy: GovernancePolicy,
): HoldEscalationReport {
  const pipeline = new PolicyPipeline(policy);
  const report: HoldEscalationReport = {
    total: candidates.length,
    rejected: 0,
    held: 0,
    flaggedOther: 0,
    approved: 0,
    escalationRate: 0,
    byTrigger: {},
    heldIds: [],
  };
  for (const candidate of candidates) {
    const result = pipeline.evaluate(candidate, {
      existingHashes: new Set<string>(),
      tenantId: candidate.tenantId,
    });
    if (result.outcome === 'rejected') {
      report.rejected++;
      continue;
    }
    const decision = evaluateHoldTriggers(candidate, result, policy);
    if (decision !== null) {
      report.held++;
      report.heldIds.push(candidate.id);
      for (const trigger of decision.triggers) {
        report.byTrigger[trigger] = (report.byTrigger[trigger] ?? 0) + 1;
      }
    } else if (result.outcome === 'flagged') {
      report.flaggedOther++;
    } else {
      report.approved++;
    }
  }
  report.escalationRate = report.total === 0 ? 0 : report.held / report.total;
  return report;
}
