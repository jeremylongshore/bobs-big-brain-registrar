import type { MemoryCandidate, PolicyRule, TrustLevel } from '@qmd-team-intent-kb/schema';
import type { EvaluationContext, RuleResult } from '../types.js';
import { deterministicScore } from '../deterministic-score.js';

/** Numeric ordering for trust levels — higher = more trusted */
const TRUST_ORDER: Record<TrustLevel, number> = {
  high: 4,
  medium: 3,
  low: 2,
  untrusted: 1,
};

const DEFAULT_MINIMUM_TRUST: TrustLevel = 'low';

function isTrustLevel(value: unknown): value is TrustLevel {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'untrusted';
}

/**
 * Rule evaluator that enforces a minimum trust level for candidates.
 * The outcome on failure uses rule.action: 'reject' → 'fail', 'flag' → 'flag'.
 * Returns a normalized trust score (0.25–1.0) on pass.
 */
export function evaluateSourceTrust(
  candidate: MemoryCandidate,
  rule: PolicyRule,
  _context: EvaluationContext,
): RuleResult {
  const minimumRaw = rule.parameters['minimumTrust'];
  const minimumTrust: TrustLevel = isTrustLevel(minimumRaw) ? minimumRaw : DEFAULT_MINIMUM_TRUST;

  const candidateScore = TRUST_ORDER[candidate.trustLevel];
  const minimumScore = TRUST_ORDER[minimumTrust];

  if (candidateScore >= minimumScore) {
    const score = candidateScore / 4; // normalize to 0.25–1.0

    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome: 'pass',
      reason: `Trust level '${candidate.trustLevel}' meets minimum '${minimumTrust}'`,
      score: deterministicScore(score),
    };
  }

  // Map rule action to outcome: 'flag' action → 'flag' outcome, anything else → 'fail'
  const outcome = rule.action === 'flag' ? 'flag' : 'fail';

  return {
    ruleId: rule.id,
    ruleType: rule.type,
    outcome,
    reason: `Trust level '${candidate.trustLevel}' is below minimum '${minimumTrust}'`,
  };
}
