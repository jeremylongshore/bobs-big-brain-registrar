import type { GovernancePolicy, MemoryCandidate, PolicyRuleType } from '@qmd-team-intent-kb/schema';
import type { EvaluationContext, PipelineResult, RuleResult } from './types.js';
import { createRule } from './rules/index.js';
import { findUncoveredRuleTypes } from './recommended-policy.js';

/**
 * Executes the full governance policy pipeline against a memory candidate.
 *
 * Rule execution is TWO-PHASE (E1 ordering invariant):
 *
 *   Phase 1 — contradiction rules (`contradiction_check`), ALWAYS evaluated
 *   first, structurally outside the reject short-circuit. A candidate that
 *   contradicts an existing active memory must carry that flag in the decision
 *   output even when another rule rejects it — a reject must never mask a
 *   contradiction signal. This phase is enforced by construction (a separate
 *   loop that runs to completion before any short-circuit exists), not by
 *   priority convention: no priority value can move a reject rule ahead of it.
 *   Phase 1 can only flag, never reject — any non-pass outcome is recorded as
 *   a flag regardless of the rule's configured action.
 *
 *   Phase 2 — every other rule:
 *     1. Sort by priority ascending (0 = highest priority, runs first)
 *     2. Skip disabled rules
 *     3. Execute each rule's evaluator
 *     4. On 'fail' + action='reject' → short-circuit and return 'rejected'
 *        (phase-1 flags are preserved on the rejected result's `flaggedBy`)
 *     5. On 'fail' + action='flag' OR outcome='flag' → record and continue
 *
 * After both phases → 'flagged' if any flags, otherwise 'approved'.
 */
export class PolicyPipeline {
  private readonly policy: GovernancePolicy;

  /**
   * Registered rule types this policy does NOT actively enforce (5bm.2).
   * Computed once at construction so the completeness gate is available at
   * RUNTIME, not only in CI — a caller (e.g. the curator) can surface which
   * rules are silently dormant on the loaded policy. Empty when the policy
   * covers the full registry.
   */
  readonly dormantRuleTypes: PolicyRuleType[];

  constructor(policy: GovernancePolicy) {
    this.policy = policy;
    this.dormantRuleTypes = findUncoveredRuleTypes(policy);
  }

  evaluate(
    candidate: MemoryCandidate,
    partialContext: Partial<EvaluationContext> = {},
  ): PipelineResult {
    const context: EvaluationContext = {
      candidate,
      policy: this.policy,
      existingHashes: partialContext.existingHashes,
      tenantId: partialContext.tenantId,
      getActiveMemoriesInCategory: partialContext.getActiveMemoriesInCategory,
    };

    const enabledRules = this.policy.rules.filter((r) => r.enabled);
    const byPriority = (a: (typeof enabledRules)[number], b: (typeof enabledRules)[number]) =>
      a.priority - b.priority;

    // Phase-1 / phase-2 partition — the ordering invariant lives in this split,
    // not in priority numbers.
    const contradictionRules = enabledRules
      .filter((r) => r.type === 'contradiction_check')
      .sort(byPriority);
    const standardRules = enabledRules
      .filter((r) => r.type !== 'contradiction_check')
      .sort(byPriority);

    const evaluations: RuleResult[] = [];
    const flaggedBy: string[] = [];

    // Phase 1: contradiction rules run to completion before any rule can
    // short-circuit. Flag-only by construction: even a (future) evaluator
    // returning 'fail' records a flag here, never a rejection.
    for (const rule of contradictionRules) {
      const evaluator = createRule(rule.type);
      const result = evaluator(candidate, rule, context);
      evaluations.push(result);
      if (result.outcome !== 'pass') {
        flaggedBy.push(rule.id);
      }
    }

    // Phase 2: standard priority-ordered evaluation with reject short-circuit.
    for (const rule of standardRules) {
      const evaluator = createRule(rule.type);
      const result = evaluator(candidate, rule, context);
      evaluations.push(result);

      if (result.outcome === 'fail') {
        if (rule.action === 'reject') {
          // Hard stop — candidate is rejected. Phase-1 contradiction flags (and
          // any flags recorded earlier in this phase) survive on the result so
          // the decision output still carries the contradiction signal.
          return {
            candidateId: candidate.id,
            outcome: 'rejected',
            evaluations,
            rejectedBy: rule.id,
            ...(flaggedBy.length > 0 ? { flaggedBy } : {}),
          };
        }
        // action is 'flag' (or 'approve'/'require_review') — record as flagged and continue
        flaggedBy.push(rule.id);
      } else if (result.outcome === 'flag') {
        flaggedBy.push(rule.id);
      }
    }

    if (flaggedBy.length > 0) {
      return {
        candidateId: candidate.id,
        outcome: 'flagged',
        evaluations,
        flaggedBy,
      };
    }

    return {
      candidateId: candidate.id,
      outcome: 'approved',
      evaluations,
    };
  }
}
