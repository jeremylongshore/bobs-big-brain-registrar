import { ndcgAtK, recallAtK } from './metrics.js';
import type { EvalDataset, EvalReport, QueryEvalResult, RetrievalFn } from './eval-types.js';

/**
 * Run an eval dataset through a retrieval backend and compute mean Recall@k +
 * nDCG@k (bead 0t9.6). Backend-agnostic: pass a `RetrievalFn` wrapping qmd's BM25
 * search today, or the native sqlite-vec backend (0t9.3) tomorrow — same harness,
 * same dataset, comparable numbers.
 */
export async function runEval(
  dataset: EvalDataset,
  retrieve: RetrievalFn,
  opts: { k?: number; backend?: string } = {},
): Promise<EvalReport> {
  const k = opts.k ?? 10;
  const backend = opts.backend ?? 'unknown';

  const perQuery: QueryEvalResult[] = [];
  for (const q of dataset.queries) {
    const retrieved = await retrieve(q.query, k);
    const relevant = new Set(q.relevant);
    perQuery.push({
      id: q.id,
      query: q.query,
      kind: q.kind,
      retrieved,
      recallAtK: recallAtK(retrieved, relevant, k),
      ndcgAtK: ndcgAtK(retrieved, relevant, k),
    });
  }

  const n = perQuery.length;
  const mean = (sel: (r: QueryEvalResult) => number): number =>
    n === 0 ? 0 : perQuery.reduce((sum, r) => sum + sel(r), 0) / n;

  return {
    dataset: dataset.name,
    backend,
    k,
    queryCount: n,
    meanRecallAtK: mean((r) => r.recallAtK),
    meanNdcgAtK: mean((r) => r.ndcgAtK),
    perQuery,
  };
}

/** Compact, human/CI-readable summary of an eval report. */
export function formatReport(report: EvalReport): string {
  return [
    `eval "${report.dataset}" · backend=${report.backend} · ${report.queryCount} queries @k=${report.k}`,
    `  mean Recall@${report.k} = ${report.meanRecallAtK.toFixed(4)}`,
    `  mean nDCG@${report.k}   = ${report.meanNdcgAtK.toFixed(4)}`,
  ].join('\n');
}

/**
 * The decision rule from ADR 038: if BM25 already clears this Recall@10 bar on the
 * real query set, the ~320MB semantic backend (0t9.3) is unjustified. Surfaced as a
 * helper so the gate is one call, not a magic number scattered around.
 */
export const BM25_SUFFICIENCY_RECALL_THRESHOLD = 0.85;

export function bm25IsSufficient(bm25Report: EvalReport): boolean {
  return bm25Report.meanRecallAtK >= BM25_SUFFICIENCY_RECALL_THRESHOLD;
}
