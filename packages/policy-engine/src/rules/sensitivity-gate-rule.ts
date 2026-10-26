import { classifyContent } from '@qmd-team-intent-kb/claude-runtime';
import { Sensitivity } from '@qmd-team-intent-kb/schema';
import type { MemoryCandidate, PolicyRule } from '@qmd-team-intent-kb/schema';
import type { EvaluationContext, RuleResult } from '../types.js';
import { effectiveSensitivity } from '../sensitivity-constraint.js';

type SensitivityLevel = Sensitivity;

const VALID_LEVELS = new Set<string>(Sensitivity.options);

/** Default blocked sensitivity levels */
const DEFAULT_BLOCKED_LEVELS: SensitivityLevel[] = ['restricted', 'confidential'];

/** Extract blockedLevels from rule parameters with runtime validation */
function parseBlockedLevels(params: Record<string, unknown> | undefined): SensitivityLevel[] {
  if (!params || !Array.isArray(params['blockedLevels'])) return DEFAULT_BLOCKED_LEVELS;
  const levels = params['blockedLevels'].filter(
    (v): v is SensitivityLevel => typeof v === 'string' && VALID_LEVELS.has(v),
  );
  return levels.length > 0 ? levels : DEFAULT_BLOCKED_LEVELS;
}

/**
 * Rule evaluator that gates promotion based on content sensitivity.
 * Uses the content classifier to determine sensitivity level and blocks
 * promotion if the level is in the configured blockedLevels list.
 *
 * Parameters:
 * - blockedLevels: string[] — sensitivity levels to block (default: ['restricted', 'confidential'])
 */
export function evaluateSensitivityGate(
  candidate: MemoryCandidate,
  rule: PolicyRule,
  context: EvaluationContext,
): RuleResult {
  const classification = classifyContent(candidate.content);
  const blockedLevels = parseBlockedLevels(rule.parameters);

  const effective = effectiveSensitivity(
    classification.sensitivityLevel,
    context.minimumSensitivity,
  );
  // Custom blocked sets need not be monotonic: raising a floor must never
  // turn an originally blocked classification into an allowed decision.
  const isBlocked =
    blockedLevels.includes(classification.sensitivityLevel) || blockedLevels.includes(effective);
  const assessed =
    context.minimumSensitivity === undefined
      ? classification.sensitivityLevel
      : `${classification.sensitivityLevel} (reviewed minimum ${context.minimumSensitivity}, effective ${effective})`;

  if (!isBlocked) {
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome: 'pass',
      reason: `Content sensitivity level '${assessed}' is allowed`,
    };
  }

  return {
    ruleId: rule.id,
    ruleType: rule.type,
    outcome: 'fail',
    reason: `Content blocked — sensitivity level '${assessed}' is restricted. Matched patterns: ${classification.matchedPatterns.join(', ')}`,
  };
}
