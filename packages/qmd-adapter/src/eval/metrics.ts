/**
 * Retrieval-quality metrics for the eval harness (bead 0t9.6).
 *
 * Binary relevance: a retrieved doc id either is or isn't in the gold-relevant
 * set. These gate BM25 vs the native semantic backend (bead 0t9.3) with measured
 * numbers instead of vibes — "no eval, no decision" (Chip Huyen / Nils Reimers).
 *
 * All metrics are robust to a retrieval list that repeats an id: each gold doc is
 * credited at most once, at its best (earliest) rank.
 */

/**
 * Recall@k — the fraction of the gold-relevant docs that appear in the top-k
 * retrieved. Returns 0 when there are no relevant docs (an unanswerable/empty
 * query contributes nothing rather than dividing by zero).
 */
export function recallAtK(
  retrieved: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) return 0;
  const found = new Set<string>();
  for (const [i, id] of retrieved.entries()) {
    if (i >= k) break;
    if (relevant.has(id)) found.add(id);
  }
  return found.size / relevant.size;
}

/**
 * Discounted Cumulative Gain at k (binary gain). Each gold doc found in the top-k
 * contributes 1 / log2(rank + 1), credited once at its earliest rank.
 */
function dcgAtK(retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  const seen = new Set<string>();
  let dcg = 0;
  for (const [i, id] of retrieved.entries()) {
    if (i >= k) break;
    if (relevant.has(id) && !seen.has(id)) {
      seen.add(id);
      dcg += 1 / Math.log2(i + 2); // rank = i + 1, discount = log2(rank + 1) = log2(i + 2)
    }
  }
  return dcg;
}

/**
 * nDCG@k (binary relevance) — DCG@k normalized by the ideal DCG (all relevant
 * docs ranked first, capped at k). 1.0 is a perfect ranking; 0 when nothing
 * relevant is retrieved or there are no relevant docs.
 */
export function ndcgAtK(
  retrieved: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) return 0;
  const dcg = dcgAtK(retrieved, relevant, k);
  const idealHits = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

/** FAMA@k and its parts for one query (bead compile-then-govern-39z.5). */
export interface FamaScore {
  /** Memory Presence Accuracy: fraction of the valid gold docs in the top-k (Recall@k). */
  mpa: number;
  /** Forgetting Absence Accuracy: fraction of the obsolete docs kept OUT of the top-k. */
  faa: number;
  /** Penalty weight: |obsolete| / (|valid| + |obsolete|); 0 when no obsolete docs are labeled. */
  lambda: number;
  /** max(0, mpa − lambda·(1 − faa)), in [0, 1]. */
  fama: number;
  /** Obsolete docs that did appear in the top-k, best rank first. */
  obsoleteRetrieved: string[];
}

/**
 * FAMA@k — Forgetting-Aware Memory Accuracy (Memora, arXiv:2604.20006), applied
 * to a ranked retrieval list instead of a generated answer:
 *
 *   FAMA = max(0, MPA − λ·(1 − FAA)),  λ = N_forget / (N_presence + N_forget)
 *
 * The paper's "presence criteria" become the valid gold docs (MPA is Recall@k
 * over them) and its "forgetting-absence criteria" become the docs labeled
 * obsolete for this query (FAA is the fraction that stay out of the top-k).
 * Recall alone cannot see a brain that ranks a torn-down platform's runbook
 * beside the current one; FAMA subtracts for it. With no obsolete docs labeled,
 * λ = 0 and FAMA equals Recall@k. A query with neither list scores 0, the same
 * as Recall@k.
 */
export function famaAtK(
  retrieved: readonly string[],
  valid: ReadonlySet<string>,
  obsolete: ReadonlySet<string>,
  k: number,
): FamaScore {
  const mpa = recallAtK(retrieved, valid, k);
  const obsoleteRetrieved: string[] = [];
  for (const [i, id] of retrieved.entries()) {
    if (i >= k) break;
    if (obsolete.has(id) && !obsoleteRetrieved.includes(id)) obsoleteRetrieved.push(id);
  }
  const faa = obsolete.size === 0 ? 1 : 1 - obsoleteRetrieved.length / obsolete.size;
  const total = valid.size + obsolete.size;
  const lambda = total === 0 ? 0 : obsolete.size / total;
  return { mpa, faa, lambda, fama: Math.max(0, mpa - lambda * (1 - faa)), obsoleteRetrieved };
}

/**
 * Reciprocal Rank — 1 / (rank of the first relevant doc), or 0 if none is
 * retrieved. (Mean over a dataset is MRR.) A useful "how high is the first good
 * hit" companion to Recall/nDCG.
 */
export function reciprocalRank(
  retrieved: readonly string[],
  relevant: ReadonlySet<string>,
): number {
  for (const [i, id] of retrieved.entries()) {
    if (relevant.has(id)) return 1 / (i + 1);
  }
  return 0;
}
