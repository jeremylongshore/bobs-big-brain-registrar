export type {
  RuleResult,
  EvaluationContext,
  RuleEvaluator,
  PipelineResult,
  ActiveMemorySnapshot,
} from './types.js';
// Seam firewall (B2): the TYPE is exported so retrieval-side tests can prove a
// rerank score is not assignable to it. The `deterministicScore()` FACTORY is
// deliberately NOT exported from the package surface — only code inside this
// govern package may mint a govern score.
export type { DeterministicScore } from './deterministic-score.js';
export { createRule, RULE_REGISTRY } from './rules/index.js';
export { evaluateSecretDetection } from './rules/secret-detection-rule.js';
export { scanTextForSecrets, listSecretPatternIds } from './secret-scan.js';
export type { SecretFinding } from './secret-scan.js';
export { evaluateContentLength } from './rules/content-length-rule.js';
export { evaluateSourceTrust } from './rules/source-trust-rule.js';
export { evaluateRelevanceScore } from './rules/relevance-score-rule.js';
export { evaluateDedupCheck } from './rules/dedup-check-rule.js';
export { evaluateTenantMatch } from './rules/tenant-match-rule.js';
export { evaluateSensitivityGate } from './rules/sensitivity-gate-rule.js';
export { evaluateContentSanitization } from './rules/content-sanitization-rule.js';
export { evaluateContradictionCheck } from './rules/contradiction-check-rule.js';
export { evaluateAudienceNarrowing, recommendAudience } from './rules/audience-narrowing-rule.js';
export type {
  AudienceRecommendation,
  AudienceRecommendationBasis,
} from './rules/audience-narrowing-rule.js';
export { PolicyPipeline } from './pipeline.js';
export {
  detectSupersession,
  planSupersession,
  computeTitleSimilarity,
  DEFAULT_SUPERSESSION_THRESHOLD,
  DEFAULT_MAX_SUPERSEDES_PER_PROMOTION,
  AUTHORITATIVE_CATEGORIES,
} from './supersession/supersession-detector.js';
export type {
  SupersessionMatch,
  SupersessionMemorySource,
  SupersessionBasis,
  SupersessionBlock,
  SupersessionPlan,
  SupersessionOptions,
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
/**
 * The deterministic redactor, re-exported for the same layering reason as
 * {@link classifyContent}: governed redaction (K3) is a write path, so the
 * curator reaches it through the govern package. Pure sync regex — no model, no
 * network, no clock. Its counterpart for DETECTION is {@link scanTextForSecrets}.
 */
export { redactSecrets } from '@qmd-team-intent-kb/claude-runtime';
