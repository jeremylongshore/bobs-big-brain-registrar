import type { MemoryCandidate, MemoryLifecycleState } from '@qmd-team-intent-kb/schema';

/**
 * The production default title-similarity threshold for supersession
 * detection. Single source of truth — the curator, the API promotion service,
 * and the govern-decision eval all consume THIS constant, so the eval can
 * never silently measure a different threshold than production runs.
 */
export const DEFAULT_SUPERSESSION_THRESHOLD = 0.6;

/** A curated memory that may be superseded by the incoming candidate */
export interface SupersessionMatch {
  supersededMemoryId: string;
  supersededTitle: string;
  similarity: number;
}

/**
 * The minimal read surface {@link detectSupersession} needs: "give me the
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
  ): ReadonlyArray<{ readonly id: string; readonly title: string; readonly category: string }>;
}

/**
 * Detects whether an incoming candidate should supersede an existing active
 * curated memory, using Jaccard similarity on title word tokens within the
 * same category and tenant.
 *
 * Only active memories in the same category as the candidate are considered.
 * When multiple memories meet the threshold the one with the highest similarity
 * is returned; ties are broken by whichever was found first.
 *
 * Moved here from `apps/curator` (Wave-2 C3) so the govern-decision eval — a
 * package — can score the REAL detector without a package→app import (the
 * dependency-cruiser `no-package-depends-on-app` invariant). The curator
 * re-exports it unchanged, so every production call site is still this exact
 * function.
 *
 * @param threshold - Minimum Jaccard similarity (0.0–1.0) to consider a match.
 *                   Defaults to {@link DEFAULT_SUPERSESSION_THRESHOLD}.
 * @returns The best-matching memory above the threshold, or null if none found.
 */
export function detectSupersession(
  candidate: MemoryCandidate,
  memorySource: SupersessionMemorySource,
  threshold: number = DEFAULT_SUPERSESSION_THRESHOLD,
): SupersessionMatch | null {
  const existingMemories = memorySource
    .findByTenantAndLifecycle(candidate.tenantId, 'active')
    .filter((m) => m.category === candidate.category);

  let bestMatch: SupersessionMatch | null = null;

  for (const memory of existingMemories) {
    const similarity = computeTitleSimilarity(candidate.title, memory.title);
    if (similarity >= threshold && (bestMatch === null || similarity > bestMatch.similarity)) {
      bestMatch = {
        supersededMemoryId: memory.id,
        supersededTitle: memory.title,
        similarity,
      };
    }
  }

  return bestMatch;
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
