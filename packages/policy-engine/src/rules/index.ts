import type { PolicyRuleType } from '@qmd-team-intent-kb/schema';
import type { RuleEvaluator } from '../types.js';
import { evaluateSecretDetection } from './secret-detection-rule.js';
import { evaluateContentLength } from './content-length-rule.js';
import { evaluateSourceTrust } from './source-trust-rule.js';
import { evaluateRelevanceScore } from './relevance-score-rule.js';
import { evaluateDedupCheck } from './dedup-check-rule.js';
import { evaluateTenantMatch } from './tenant-match-rule.js';
import { evaluateSensitivityGate } from './sensitivity-gate-rule.js';
import { evaluateContentSanitization } from './content-sanitization-rule.js';
import { evaluateContradictionCheck } from './contradiction-check-rule.js';

/** Registry mapping PolicyRuleType values to their evaluator functions */
export const RULE_REGISTRY: Record<PolicyRuleType, RuleEvaluator> = {
  secret_detection: evaluateSecretDetection,
  content_length: evaluateContentLength,
  source_trust: evaluateSourceTrust,
  relevance_score: evaluateRelevanceScore,
  dedup_check: evaluateDedupCheck,
  tenant_match: evaluateTenantMatch,
  sensitivity_gate: evaluateSensitivityGate,
  content_sanitization: evaluateContentSanitization,
  contradiction_check: evaluateContradictionCheck,
};

/**
 * Factory function that looks up the evaluator for a given rule type.
 * Throws a TypeError at development time if an unregistered type is requested
 * (this is a programming error, not a runtime data error).
 */
export function createRule(type: PolicyRuleType): RuleEvaluator {
  const evaluator = RULE_REGISTRY[type];
  return evaluator;
}
