import type { MemoryCandidate, PolicyRule } from '@qmd-team-intent-kb/schema';
import type { EvaluationContext, RuleResult } from '../types.js';
import { deterministicScore } from '../deterministic-score.js';

const DEFAULT_MINIMUM_SCORE = 0.3;

/**
 * Deterministic relevance scoring rule. No LLM involvement — purely structural heuristics.
 *
 * Scoring breakdown (max 1.0):
 *   +0.20  title present and non-empty
 *   +0.10  content length > 50 and <= 200 chars
 *   +0.20  content length > 200 chars (replaces the 0.10 tier above)
 *   +0.05  category is set
 *   +0.10  metadata has at least one filePath
 *   +0.10  metadata has projectContext
 *   +0.10  metadata has at least one tag
 *   +0.05  trustLevel is 'high'
 *   +0.10  unique word count in content > 15
 *   +0.10  source is 'manual' or 'import'
 *
 * Candidates scoring below minimumScore are flagged (not rejected — low relevance is not fatal).
 */
export function evaluateRelevanceScore(
  candidate: MemoryCandidate,
  rule: PolicyRule,
  _context: EvaluationContext,
): RuleResult {
  const minimumScore =
    typeof rule.parameters['minimumScore'] === 'number'
      ? rule.parameters['minimumScore']
      : DEFAULT_MINIMUM_SCORE;

  let score = 0;

  // +0.20 for a non-empty title (NonEmptyString guarantees at least 1 char after trim, but be safe)
  if (candidate.title.trim().length > 0) {
    score += 0.2;
  }

  // Graduated content length: +0.10 for 50-200 chars, +0.20 for > 200 chars
  if (candidate.content.length > 200) {
    score += 0.2;
  } else if (candidate.content.length > 50) {
    score += 0.1;
  }

  // +0.05 for category being set (it always is per schema, but we check for type safety)
  if (candidate.category) {
    score += 0.05;
  }

  // +0.10 for at least one filePath in metadata
  if (candidate.metadata.filePaths.length > 0) {
    score += 0.1;
  }

  // +0.10 for projectContext being present
  if (candidate.metadata.projectContext !== undefined && candidate.metadata.projectContext !== '') {
    score += 0.1;
  }

  // +0.10 for at least one tag
  if (candidate.metadata.tags.length > 0) {
    score += 0.1;
  }

  // +0.05 for high trust level
  if (candidate.trustLevel === 'high') {
    score += 0.05;
  }

  // +0.10 for unique word count > 15 (measures lexical richness)
  const uniqueWordCount = new Set(
    candidate.content
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  ).size;
  if (uniqueWordCount > 15) {
    score += 0.1;
  }

  // +0.10 for manually authored or imported content (higher provenance confidence)
  if (candidate.source === 'manual' || candidate.source === 'import') {
    score += 0.1;
  }

  // Round to avoid floating point noise
  score = Math.round(score * 100) / 100;

  if (score >= minimumScore) {
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome: 'pass',
      reason: `Relevance score ${score.toFixed(2)} meets minimum ${minimumScore.toFixed(2)}`,
      score: deterministicScore(score),
    };
  }

  return {
    ruleId: rule.id,
    ruleType: rule.type,
    outcome: 'flag',
    reason: `Relevance score ${score.toFixed(2)} is below minimum ${minimumScore.toFixed(2)}`,
    score: deterministicScore(score),
  };
}
