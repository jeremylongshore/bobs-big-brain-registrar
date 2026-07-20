import type { MemoryCandidate, PolicyRule } from '@qmd-team-intent-kb/schema';
import type { EvaluationContext, RuleResult } from '../types.js';
import { deterministicScore } from '../deterministic-score.js';

/**
 * Default Jaccard token-overlap similarity at or above which a candidate is
 * flagged as a potential contradiction of an existing active memory.
 * Conservative on purpose: 0.6 means the two texts share well over half their
 * combined vocabulary — same-topic territory — while ordinary same-category
 * memories about different things sit far below it.
 */
const DEFAULT_THRESHOLD = 0.6;

/** Cap on how many suspect memory ids are named in the flag reason. */
const MAX_REPORTED = 5;

/** Parse and clamp the similarity threshold from rule parameters. */
function parseThreshold(params: Record<string, unknown> | undefined): number {
  const raw = params?.['threshold'];
  if (typeof raw !== 'number' || Number.isNaN(raw)) return DEFAULT_THRESHOLD;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Word/character-segmenting Unicode token pattern (E1 review follow-up).
 *
 * The prior ASCII-only `[a-z0-9]+` collapsed any non-Latin text (Cyrillic, CJK,
 * accented words) to an empty token set. The Unicode swap fixes space-delimited
 * scripts (Cyrillic, Greek, accented Latin), but a run of CJK ideographs carries
 * NO word spaces, so `[\p{L}\p{N}]+` alone would make one long sentence a single
 * token — two near-identical CJK sentences would then share zero tokens and never
 * flag. So CJK scripts (Han / Hiragana / Katakana / Hangul) are segmented per
 * character (the standard unigram approximation for space-less scripts), while
 * every other script keeps whole-word runs. Alternation order matters: a single
 * CJK char is matched before the general letter/digit run so it is never glued
 * into a longer token.
 */
const TOKEN_PATTERN = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]|[\p{L}\p{N}]+/gu;

/**
 * Lowercased token set of a text — whole words for space-delimited scripts,
 * per-character tokens for space-less CJK. See {@link TOKEN_PATTERN}.
 */
function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(TOKEN_PATTERN) ?? []);
}

/** Jaccard similarity of two token sets: |A ∩ B| / |A ∪ B| (0 when both empty). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Rule evaluator that flags a candidate whose content overlaps heavily with an
 * existing ACTIVE memory in the SAME category without being byte-identical
 * (GSB blueprint Track E1).
 *
 * ## v1 heuristic — token overlap, honestly stated
 *
 * Detection is Jaccard similarity over lowercased Unicode token sets (whole words
 * for space-delimited scripts, per-character for space-less CJK).
 * Token overlap is NOT semantic contradiction — "deploy on Fridays" and "never
 * deploy on Fridays" score high, but so do two compatible restatements of the
 * same convention. What high overlap reliably means is *same topic, different
 * text*: exactly the shape a contradiction takes, and exactly what a human
 * should read before the candidate is promoted. So v1 surfaces these for
 * review; it never decides. Semantic contradiction detection is deliberately
 * deferred (Wave-2 C3/E2 territory) and, per the core invariant, any model
 * involvement would propose — this deterministic pipeline would still own the
 * decision.
 *
 * ## Behavioural contract
 *
 * - Returns only `pass` or `flag`, NEVER `fail` — so no `action: 'reject'`
 *   configuration can turn a v1 contradiction hit into a rejection.
 * - Byte-identical content is skipped: exact duplication is `dedup_check`'s
 *   job (which runs separately on content hashes); double-reporting it here
 *   would be noise.
 * - Scoped to the candidate's own category via
 *   {@link EvaluationContext.getActiveMemoriesInCategory}; when the lookup is
 *   not injected the rule passes vacuously (mirrors `dedup_check` without
 *   `existingHashes`).
 *
 * Parameters:
 * - threshold: number — Jaccard similarity in [0, 1] at or above which to flag
 *   (default 0.6).
 */
export function evaluateContradictionCheck(
  candidate: MemoryCandidate,
  rule: PolicyRule,
  context: EvaluationContext,
): RuleResult {
  if (context.getActiveMemoriesInCategory === undefined) {
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome: 'pass',
      reason: 'No active-memory lookup provided — contradiction check skipped',
    };
  }

  const threshold = parseThreshold(rule.parameters);
  const candidateTokens = tokenSet(candidate.content);
  const suspects: Array<{ id: string; similarity: number }> = [];

  for (const memory of context.getActiveMemoriesInCategory(candidate.category)) {
    // Byte-identical content is dedupe's job, not a contradiction.
    if (memory.content === candidate.content) continue;
    const similarity = jaccard(candidateTokens, tokenSet(memory.content));
    if (similarity >= threshold) {
      suspects.push({ id: memory.id, similarity });
    }
  }

  if (suspects.length === 0) {
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome: 'pass',
      reason: `No active '${candidate.category}' memory overlaps at or above ${threshold}`,
    };
  }

  suspects.sort((a, b) => b.similarity - a.similarity);
  const reported = suspects
    .slice(0, MAX_REPORTED)
    .map((s) => `${s.id} (${s.similarity.toFixed(2)})`)
    .join(', ');

  return {
    ruleId: rule.id,
    ruleType: rule.type,
    outcome: 'flag',
    reason:
      `Potential contradiction: high token overlap with ${suspects.length} active ` +
      `'${candidate.category}' memor${suspects.length === 1 ? 'y' : 'ies'} — ${reported}. ` +
      'v1 heuristic (token overlap, not semantic) — human review required.',
    // Jaccard overlap is pure token arithmetic — a legitimate govern-side
    // deterministic score, minted via the factory the seam firewall requires.
    score: suspects[0] !== undefined ? deterministicScore(suspects[0].similarity) : undefined,
  };
}
