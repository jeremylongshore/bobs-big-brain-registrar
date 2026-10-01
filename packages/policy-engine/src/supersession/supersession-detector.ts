import type { MemoryCandidate, MemoryLifecycleState } from '@qmd-team-intent-kb/schema';

/**
 * The production default title-similarity threshold for the legacy
 * near-duplicate fallback. Single source of truth — the curator, the API
 * promotion service, and the govern-decision eval all consume THIS constant, so
 * the eval can never silently measure a different threshold than production
 * runs.
 */
export const DEFAULT_SUPERSESSION_THRESHOLD = 0.6;

/** How a supersession match was established. */
export type SupersessionBasis = 'subject' | 'title';

/** A curated memory that may be superseded by the incoming candidate */
export interface SupersessionMatch {
  supersededMemoryId: string;
  supersededTitle: string;
  /** 1.0 for a subject-key match (exact identity); Jaccard score for a title match. */
  similarity: number;
  /** `subject` = shared explicit subject key; `title` = same-category title-Jaccard fallback. */
  basis: SupersessionBasis;
  /** The shared subject key (only when `basis === 'subject'`). */
  subject?: string;
}

/**
 * Categories whose memories are AUTHORITATIVE statements of current truth. Only
 * these may retire a memory of a DIFFERENT category (e.g. a `decision` retiring
 * a stale `reference`). A lower-authority memory (a `reference`, `pattern`,
 * `troubleshooting`, `onboarding` note) can only supersede within its own
 * category, so a re-captured reference can never retire a decision.
 */
export const AUTHORITATIVE_CATEGORIES: ReadonlySet<string> = new Set([
  'decision',
  'architecture',
  'convention',
]);

/**
 * Hard ceiling on how many memories one promotion may retire by subject match.
 * A subject key matching more than this is treated as mis-keyed or over-broad:
 * NOTHING is superseded (fail closed) and the plan reports the blocked count.
 * Raising it is an explicit per-call opt-in (`maxSupersedes`), never a default.
 */
export const DEFAULT_MAX_SUPERSEDES_PER_PROMOTION = 25;

/**
 * The minimal read surface {@link planSupersession} needs: "give me the
 * active memories of this tenant". `@qmd-team-intent-kb/store`'s
 * `MemoryRepository` satisfies it structurally — the interface exists so this
 * detector can live in policy-engine (a package) without importing the store,
 * keeping the package layer store-free while every caller keeps passing the
 * real repository.
 */
export interface SupersessionMemorySource {
  findByTenantAndLifecycle(
    tenantId: string,
    lifecycle: MemoryLifecycleState,
  ): ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly category: string;
    /** Present on real curated memories; optional so minimal fakes still satisfy the source. */
    readonly metadata?: { readonly subjects?: readonly string[] };
    readonly promotedAt?: string;
  }>;
}

/** Why a plan refused to supersede anything it otherwise would have. */
export interface SupersessionBlock {
  reason: 'cap_exceeded';
  /** How many memories the subject match WOULD have retired. */
  wouldSupersede: number;
  /** The cap that was in force. */
  cap: number;
  subjects: string[];
}

/**
 * Deterministic supersession plan for one candidate — pure and read-only. It is
 * the dry-run/report artifact: callers decide whether to apply it.
 */
export interface SupersessionPlan {
  matches: SupersessionMatch[];
  /** Set when a guard refused the subject match (matches is then empty). */
  blocked?: SupersessionBlock;
}

export interface SupersessionOptions {
  /** Title-Jaccard threshold for the same-category fallback. Default {@link DEFAULT_SUPERSESSION_THRESHOLD}. */
  threshold?: number;
  /** Per-promotion cap on subject-key retirements. Default {@link DEFAULT_MAX_SUPERSEDES_PER_PROMOTION}. */
  maxSupersedes?: number;
}

/**
 * Plans which active memories an incoming candidate retires. Deterministic: no
 * model, clock, or network.
 *
 * 1. SUBJECT-KEYED (primary). When the candidate declares `metadata.subjects`,
 *    every ACTIVE same-tenant memory sharing at least one subject key is a
 *    supersession target — in ANY category, provided the candidate is in an
 *    {@link AUTHORITATIVE_CATEGORIES} category or the target is in the
 *    candidate's own category. A target promoted AFTER the candidate was
 *    captured is never retired (a stale candidate cannot retire newer truth).
 *    If more than `maxSupersedes` targets match, the plan is BLOCKED and
 *    retires nothing (no silent mass-supersede).
 * 2. TITLE FALLBACK (legacy). Only when no subject match exists: the best
 *    same-category memory with title-Jaccard >= threshold. A near-duplicate
 *    collapser for un-keyed memories; never cross-category.
 */
export function planSupersession(
  candidate: MemoryCandidate,
  memorySource: SupersessionMemorySource,
  options: SupersessionOptions = {},
): SupersessionPlan {
  const threshold = options.threshold ?? DEFAULT_SUPERSESSION_THRESHOLD;
  const cap = options.maxSupersedes ?? DEFAULT_MAX_SUPERSEDES_PER_PROMOTION;
  const active = memorySource.findByTenantAndLifecycle(candidate.tenantId, 'active');

  const candidateSubjects = new Set(candidate.metadata.subjects ?? []);
  if (candidateSubjects.size > 0) {
    const authoritative = AUTHORITATIVE_CATEGORIES.has(candidate.category);
    const matches: SupersessionMatch[] = [];
    for (const memory of active) {
      const shared = (memory.metadata?.subjects ?? [])
        .filter((s) => candidateSubjects.has(s))
        .sort()[0];
      if (shared === undefined) continue;
      if (!authoritative && memory.category !== candidate.category) continue;
      // Never retire a memory newer than the candidate's own capture time.
      if (memory.promotedAt !== undefined && memory.promotedAt > candidate.capturedAt) continue;
      matches.push({
        supersededMemoryId: memory.id,
        supersededTitle: memory.title,
        similarity: 1,
        basis: 'subject',
        subject: shared,
      });
    }
    if (matches.length > cap) {
      return {
        matches: [],
        blocked: {
          reason: 'cap_exceeded',
          wouldSupersede: matches.length,
          cap,
          subjects: [...candidateSubjects].sort(),
        },
      };
    }
    if (matches.length > 0) {
      matches.sort((a, b) => a.supersededMemoryId.localeCompare(b.supersededMemoryId));
      return { matches };
    }
  }

  let best: SupersessionMatch | null = null;
  for (const memory of active) {
    if (memory.category !== candidate.category) continue;
    const similarity = computeTitleSimilarity(candidate.title, memory.title);
    if (similarity >= threshold && (best === null || similarity > best.similarity)) {
      best = {
        supersededMemoryId: memory.id,
        supersededTitle: memory.title,
        similarity,
        basis: 'title',
      };
    }
  }
  return { matches: best === null ? [] : [best] };
}

/**
 * Single-match convenience over {@link planSupersession}: the first planned
 * match, or null. Kept for the govern-decision eval, which scores "would the
 * detector fire".
 *
 * @param threshold - Minimum Jaccard similarity (0.0–1.0) for the title fallback.
 */
export function detectSupersession(
  candidate: MemoryCandidate,
  memorySource: SupersessionMemorySource,
  threshold: number = DEFAULT_SUPERSESSION_THRESHOLD,
): SupersessionMatch | null {
  return planSupersession(candidate, memorySource, { threshold }).matches[0] ?? null;
}

/**
 * Computes Jaccard similarity between two strings using word-level tokenization.
 *
 * Jaccard similarity = |intersection| / |union|
 *
 * Both strings are lower-cased and split on whitespace. Empty strings produce
 * 1.0 when both are empty (identical) and 0.0 when only one is empty.
 */
export function computeTitleSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));

  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}
