import type { MemoryCandidate, PolicyRule } from '@qmd-team-intent-kb/schema';
import type { EvaluationContext, RuleResult } from '../types.js';
import { deterministicScore } from '../deterministic-score.js';

const DEFAULT_MIN = 10;
const DEFAULT_MAX = 50000;

/**
 * Rule evaluator that validates candidate content length falls within configured bounds.
 * Returns a normalized score (content.length / max) on pass.
 */
export function evaluateContentLength(
  candidate: MemoryCandidate,
  rule: PolicyRule,
  _context: EvaluationContext,
): RuleResult {
  const min = typeof rule.parameters['min'] === 'number' ? rule.parameters['min'] : DEFAULT_MIN;
  const max = typeof rule.parameters['max'] === 'number' ? rule.parameters['max'] : DEFAULT_MAX;

  const length = candidate.content.length;

  if (length < min) {
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome: 'fail',
      reason: `Content too short (${length} chars, minimum ${min})`,
    };
  }

  if (length > max) {
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome: 'fail',
      reason: `Content too long (${length} chars, maximum ${max})`,
    };
  }

  const score = Math.min(length / max, 1);

  return {
    ruleId: rule.id,
    ruleType: rule.type,
    outcome: 'pass',
    reason: `Content length ${length} chars is within bounds [${min}, ${max}]`,
    score: deterministicScore(score),
  };
}
