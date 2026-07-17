import type { QmdSearchResult } from '../types.js';
import type { Fts5SearchHit } from '../native/fts5-backend.js';

/**
 * Reciprocal-rank-fusion constant. The standard k=60 from Cormack et al. —
 * large enough that a document's absolute rank matters less than appearing in
 * both lists, which is exactly the property we want when fusing two lexical
 * backends with different tokenizers.
 */
export const RRF_K = 60;

/**
 * Fuse the qmd binary's ranked list with the native FTS5 ranked list using
 * deterministic reciprocal-rank fusion (retrieval epic, qmd-team-intent-kb-vps.2):
 *
 *   rrf(d) = Σ over lists containing d of 1 / (k + rank_d)   (rank is 1-based)
 *
 * Join key is the `qmd://` citation (both backends emit the same ids). The two
 * backends deliberately differ in tokenization — qmd's keyword-AND misses
 * hyphen/dot-joined terms ("governed-brain", "CLAUDE.md") that FTS5's unicode61
 * tokenizer splits and matches — so their union, not either list alone, is the
 * recall surface.
 *
 * Determinism: ties break by best single-list rank, then by id lexicographic
 * order. No randomness, no model call.
 *
 * Snippet/collection prefer the qmd hit (its diff-style snippets carry more
 * context); FTS5 fills in for hits qmd missed. The fused score is the raw RRF
 * score (~1/60 scale) — callers normalise to [0,1] against the top hit, which
 * the API service already does.
 */
export function fuseReciprocalRank(
  qmdHits: readonly QmdSearchResult[],
  nativeHits: readonly Fts5SearchHit[],
  k: number = RRF_K,
): QmdSearchResult[] {
  interface FusedEntry {
    id: string;
    score: number;
    bestRank: number;
    qmdHit?: QmdSearchResult;
    nativeHit?: Fts5SearchHit;
  }

  const entries = new Map<string, FusedEntry>();

  qmdHits.forEach((hit, i) => {
    const rank = i + 1;
    const entry = entries.get(hit.file) ?? { id: hit.file, score: 0, bestRank: Infinity };
    entry.score += 1 / (k + rank);
    entry.bestRank = Math.min(entry.bestRank, rank);
    entry.qmdHit ??= hit;
    entries.set(hit.file, entry);
  });

  nativeHits.forEach((hit, i) => {
    const rank = i + 1;
    const entry = entries.get(hit.id) ?? { id: hit.id, score: 0, bestRank: Infinity };
    entry.score += 1 / (k + rank);
    entry.bestRank = Math.min(entry.bestRank, rank);
    entry.nativeHit ??= hit;
    entries.set(hit.id, entry);
  });

  return [...entries.values()]
    .sort(
      (a, b) =>
        b.score - a.score || a.bestRank - b.bestRank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((entry) => ({
      file: entry.id,
      score: entry.score,
      snippet:
        entry.qmdHit?.snippet !== undefined && entry.qmdHit.snippet !== ''
          ? entry.qmdHit.snippet
          : (entry.nativeHit?.snippet ?? ''),
      collection: entry.qmdHit?.collection ?? entry.nativeHit?.collection ?? 'unknown',
    }));
}
