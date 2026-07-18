/**
 * Compute a freshness multiplier (0.0–1.0) based on memory age.
 * Uses exponential decay: score = e^(-lambda * ageDays)
 * Default half-life: 90 days (lambda = ln(2)/90 ≈ 0.0077)
 */
export function computeFreshnessScore(
  updatedAt: string,
  nowIso: string,
  halfLifeDays: number = 90,
): number {
  const updatedMs = new Date(updatedAt).getTime();
  const nowMs = new Date(nowIso).getTime();
  const ageDays = Math.max(0, (nowMs - updatedMs) / (1000 * 60 * 60 * 24));
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}

/** Category importance weights for search ranking */
export const CATEGORY_BOOST: Record<string, number> = {
  decision: 1.2,
  architecture: 1.15,
  convention: 1.1,
  pattern: 1.1,
  troubleshooting: 1.0,
  onboarding: 0.95,
  reference: 0.9,
};

/**
 * Rerank search hits by combining raw score with freshness and category boost.
 * finalScore = rawScore * freshnessMultiplier * categoryBoost
 * Returns hits sorted by finalScore descending.
 */
export function rerankSearchHits<T extends { score: number; category: string; updatedAt: string }>(
  hits: T[],
  nowIso: string,
  halfLifeDays: number = 90,
): Array<T & { finalScore: number }> {
  return hits
    .map((hit) => {
      const freshness = computeFreshnessScore(hit.updatedAt, nowIso, halfLifeDays);
      const categoryBoost = CATEGORY_BOOST[hit.category] ?? 1.0;
      const finalScore = Math.round(hit.score * freshness * categoryBoost * 1000) / 1000;
      return { ...hit, finalScore };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Extract the memory id from a qmd citation URI or exported file path.
 * The git-exporter names every file `{memoryId}.md`, so the basename minus
 * its extension IS the memory id. Returns null for an empty basename.
 */
export function extractMemoryIdFromCitation(citation: string): string | null {
  const lastSlash = citation.lastIndexOf('/');
  const base = lastSlash === -1 ? citation : citation.slice(lastSlash + 1);
  const stripped = base.replace(/\.[^.]+$/, '');
  return stripped.length > 0 ? stripped : null;
}

/** Metadata needed to freshness-rerank a cited hit. */
export interface CitedHitMetadata {
  category: string;
  updatedAt: string;
  /** Sensitivity of the resolved memory (5bm.11), so a cited hit can be
   * sensitivity-filtered at read time. Optional: a resolver that doesn't supply
   * it (e.g. a rank-only caller) leaves the hit search-visible ('public'). */
  sensitivity?: string;
}

/**
 * Sensitivity levels kept OUT of general search results (5bm.11) — the same
 * levels the git-exporter skips (5bm.3), so a confidential/restricted memory is
 * never returned to a search caller. A memory whose sensitivity is not one of
 * these is search-visible.
 */
export const SEARCH_HIDDEN_SENSITIVITY: ReadonlySet<string> = new Set([
  'confidential',
  'restricted',
]);

/** True if a memory of this sensitivity may appear in general search results. */
export function isSearchVisibleSensitivity(sensitivity: string): boolean {
  return !SEARCH_HIDDEN_SENSITIVITY.has(sensitivity);
}

/**
 * Rerank qmd-cited hits with freshness + category boost by resolving each
 * citation back to its governed memory's metadata.
 *
 * A hit whose citation cannot be resolved (memory removed from the store, or
 * a non-standard filename) is treated as fresh and unboosted — freshness 1.0
 * (updatedAt = now) and category boost 1.0 — so resolution failure never
 * penalizes a hit; it just doesn't get boosted. Resolved hits carry their
 * memoryId so callers can enrich the response.
 */
export function rerankCitedHits<T extends { file: string; score: number }>(
  hits: T[],
  resolveMetadata: (memoryId: string) => CitedHitMetadata | null,
  nowIso: string,
  halfLifeDays: number = 90,
): Array<
  T & {
    finalScore: number;
    category: string;
    updatedAt: string;
    sensitivity: string;
    memoryId: string | null;
  }
> {
  const enriched = hits.map((h) => {
    const id = extractMemoryIdFromCitation(h.file);
    const meta = id === null ? null : resolveMetadata(id);
    return {
      ...h,
      memoryId: meta === null ? null : id,
      category: meta?.category ?? '',
      updatedAt: meta?.updatedAt ?? nowIso,
      // Unresolvable hit (orphaned citation) is not an identifiable sensitive
      // memory — treat as public/searchable; a resolved hit carries its real level.
      sensitivity: meta?.sensitivity ?? 'public',
    };
  });
  return rerankSearchHits(enriched, nowIso, halfLifeDays);
}
