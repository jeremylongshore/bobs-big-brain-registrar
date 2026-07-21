import type { QmdSearchResult } from '../types.js';
import type { Fts5SearchHit } from '../native/fts5-backend.js';
import type { DenseSearchHit } from '../dense/dense-index.js';

/**
 * Reciprocal-rank-fusion constant. The standard k=60 from Cormack et al. —
 * large enough that a document's absolute rank matters less than appearing in
 * both lists, which is exactly the property we want when fusing two lexical
 * backends with different tokenizers.
 */
export const RRF_K = 60;

/**
 * Fuse the qmd binary's ranked list with the native FTS5 ranked list — and,
 * when the opt-in dense arm (bead B4) supplies one, the dense KNN ranked list
 * — using deterministic reciprocal-rank fusion (retrieval epic,
 * qmd-team-intent-kb-vps.2):
 *
 *   rrf(d) = Σ over lists containing d of 1 / (k + rank_d)   (rank is 1-based)
 *
 * Join key is the `qmd://` citation (all backends emit the same ids). The two
 * lexical backends deliberately differ in tokenization — qmd's keyword-AND
 * misses hyphen/dot-joined terms ("governed-brain", "CLAUDE.md") that FTS5's
 * unicode61 tokenizer splits and matches; the dense list contributes documents
 * neither lexical backend can retrieve at all (paraphrase queries sharing no
 * tokens with the doc) — so their union, not any list alone, is the recall
 * surface.
 *
 * Determinism given the input lists: ties break by best single-list rank, then
 * by id lexicographic order. The FUSION itself performs no model call and only
 * ever consumes list RANKS — a dense hit's model-derived `DenseScore` never
 * flows into the fused score, which stays a pure rank arithmetic value. (With
 * an empty dense list — the default — the function is the same deterministic
 * two-list fusion it always was.)
 *
 * Snippet/collection prefer the qmd hit (its diff-style snippets carry more
 * context); FTS5 fills in for hits qmd missed, then the dense doc's stored
 * lead text. The fused score is the raw RRF score (~1/60 scale) — callers
 * normalise to [0,1] against the top hit, which the API service already does.
 */
export function fuseReciprocalRank(
  qmdHits: readonly QmdSearchResult[],
  nativeHits: readonly Fts5SearchHit[],
  denseHits: readonly DenseSearchHit[] = [],
  k: number = RRF_K,
): QmdSearchResult[] {
  interface FusedEntry {
    id: string;
    score: number;
    bestRank: number;
    qmdHit?: QmdSearchResult;
    nativeHit?: Fts5SearchHit;
    denseHit?: DenseSearchHit;
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

  denseHits.forEach((hit, i) => {
    const rank = i + 1;
    const entry = entries.get(hit.id) ?? { id: hit.id, score: 0, bestRank: Infinity };
    entry.score += 1 / (k + rank);
    entry.bestRank = Math.min(entry.bestRank, rank);
    entry.denseHit ??= hit;
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
          : entry.nativeHit?.snippet !== undefined && entry.nativeHit.snippet !== ''
            ? entry.nativeHit.snippet
            : (entry.denseHit?.snippet ?? ''),
      collection:
        entry.qmdHit?.collection ??
        entry.nativeHit?.collection ??
        entry.denseHit?.collection ??
        'unknown',
    }));
}
