import { MemorySource, type MemoryCandidate, type PolicyRule } from '@qmd-team-intent-kb/schema';
import type { EvaluationContext, RuleResult } from '../types.js';
import { deterministicScore } from '../deterministic-score.js';

const DEFAULT_MINIMUM_SCORE = 0.3;

/**
 * Sources whose below-threshold candidates FAIL (hard-rejectable) by default
 * (bead qmd-team-intent-kb-5kw.3): bulk-imported content has no per-item human
 * intent behind it, so junk that scores below the relevance floor should be
 * turned away at spool intake instead of merely flagged — the 2026-07-16
 * digestion promoted ~15k unfiltered candidates because every rule outcome was
 * advisory. Interactive sources (`claude_session`, `manual`, `mcp`) keep the
 * original flag-only behavior by default: a human/session capture that scores
 * low is a review case, not junk.
 */
const DEFAULT_REJECT_SOURCES: readonly string[] = ['import', 'bulk_import'];

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
 * ## Below-threshold outcome is SOURCE-KEYED (5kw.3)
 *
 * A candidate scoring below `minimumScore`:
 *   - source ∈ `rejectSources` (param; default `['import', 'bulk_import']`) →
 *     outcome **'fail'** — the pipeline REJECTS when the rule's configured
 *     action is 'reject', flags otherwise. The hard reject is therefore a
 *     two-key turn: the evaluator marks the candidate rejectable (source-keyed)
 *     AND the policy names 'reject' as the action. Pre-5kw policies carrying
 *     action 'flag' keep their exact previous behavior.
 *   - any other source → outcome **'flag'** — never rejects regardless of the
 *     configured action (low relevance on an interactive capture is a review
 *     signal, not fatal).
 *
 * `rejectSources` entries are validated against the {@link MemorySource} enum;
 * unknown values are ignored deterministically (a typo can only make the rule
 * SOFTER, never widen the reject surface).
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

  const rawRejectSources = rule.parameters['rejectSources'];
  const rejectSources: readonly string[] = Array.isArray(rawRejectSources)
    ? rawRejectSources.filter(
        (s): s is string => typeof s === 'string' && MemorySource.safeParse(s).success,
      )
    : DEFAULT_REJECT_SOURCES;

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

  // Source-keyed severity (5kw.3): 'fail' makes the candidate rejectable when
  // the policy's action is 'reject'; 'flag' can never reject.
  if (rejectSources.includes(candidate.source)) {
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome: 'fail',
      reason:
        `Relevance score ${score.toFixed(2)} is below minimum ${minimumScore.toFixed(2)} ` +
        `for import-class source '${candidate.source}' (hard-rejectable per rule parameters)`,
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
