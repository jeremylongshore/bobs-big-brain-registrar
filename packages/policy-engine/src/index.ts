export type {
  RuleResult,
  EvaluationContext,
  RuleEvaluator,
  PipelineResult,
  ActiveMemorySnapshot,
} from './types.js';
export { createRule, RULE_REGISTRY } from './rules/index.js';
export { evaluateSecretDetection } from './rules/secret-detection-rule.js';
export { evaluateContentLength } from './rules/content-length-rule.js';
export { evaluateSourceTrust } from './rules/source-trust-rule.js';
export { evaluateRelevanceScore } from './rules/relevance-score-rule.js';
export { evaluateDedupCheck } from './rules/dedup-check-rule.js';
export { evaluateTenantMatch } from './rules/tenant-match-rule.js';
export { evaluateSensitivityGate } from './rules/sensitivity-gate-rule.js';
export { evaluateContentSanitization } from './rules/content-sanitization-rule.js';
export { evaluateContradictionCheck } from './rules/contradiction-check-rule.js';
export { PolicyPipeline } from './pipeline.js';
export {
  detectSupersession,
  computeTitleSimilarity,
} from './supersession/supersession-detector.js';
export type {
  SupersessionMatch,
  SupersessionMemorySource,
} from './supersession/supersession-detector.js';
export {
  RECOMMENDED_POLICY_RULES,
  buildRecommendedPolicy,
  findUncoveredRuleTypes,
  assertPolicyCompleteness,
} from './recommended-policy.js';
/**
 * Deterministic content classifier, re-exported from the govern layer so the
 * deterministic write path (curator's promoter) depends on policy-engine — a
 * govern package — rather than importing `@qmd-team-intent-kb/claude-runtime`
 * directly. The function itself is pure sync regex today; routing it through
 * here keeps the govern path's declared dependency LLM-free by layering, so a
 * future model call in `claude-runtime` cannot silently reach the write path
 * without also changing this deliberate re-export.
 */
export { classifyContent } from '@qmd-team-intent-kb/claude-runtime';
export type { ContentClassification } from '@qmd-team-intent-kb/claude-runtime';
