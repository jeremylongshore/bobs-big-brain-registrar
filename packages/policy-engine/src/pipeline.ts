import type { GovernancePolicy, MemoryCandidate, PolicyRuleType } from '@qmd-team-intent-kb/schema';
import type { EvaluationContext, PipelineResult, RuleResult } from './types.js';
import { createRule } from './rules/index.js';
import { findUncoveredRuleTypes } from './recommended-policy.js';

/**
 * Executes the full governance policy pipeline against a memory candidate.
 *
 * Rule execution order:
 *   1. Sort by priority ascending (0 = highest priority, runs first)
 *   2. Skip disabled rules
 *   3. Execute each rule's evaluator
 *   4. On 'fail' + action='reject' → short-circuit and return 'rejected'
 *   5. On 'fail' + action='flag' OR outcome='flag' → record and continue
 *   6. After all rules → 'flagged' if any flags, otherwise 'approved'
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
    };

    // Sort enabled rules by priority ascending (lower number = higher priority)
    const orderedRules = this.policy.rules
      .filter((r) => r.enabled)
      .sort((a, b) => a.priority - b.priority);

    const evaluations: RuleResult[] = [];
    const flaggedBy: string[] = [];

    for (const rule of orderedRules) {
      const evaluator = createRule(rule.type);
      const result = evaluator(candidate, rule, context);
      evaluations.push(result);

      if (result.outcome === 'fail') {
        if (rule.action === 'reject') {
          // Hard stop — candidate is rejected
          return {
            candidateId: candidate.id,
            outcome: 'rejected',
            evaluations,
            rejectedBy: rule.id,
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
