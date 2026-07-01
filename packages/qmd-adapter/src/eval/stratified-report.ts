import { reciprocalRank } from './metrics.js';
import type { EvalReport, EvalQuery } from './eval-types.js';

/**
 * Stratified reporting over an {@link EvalReport} (bead compile-then-govern-e06.4 /
 * umbrella #27).
 *
 * ADR 038-AT-DECR does not gate on ONE overall Recall@10 — it gates on where the
 * recall wall shows up, which is the SEMANTIC (paraphrase / concept) stratum.
 * BM25 is strong on `lexical` queries (exact terms / names) and silently weak on
 * `semantic` ones; a healthy overall mean can hide a semantic collapse. So the
 * real verdict needs the split, not just the aggregate.
 *
 * This is a thin, read-only slice over the per-query results {@link runEval}
 * already computes — it adds no new retrieval, just groups by `kind` and adds
 * MRR (mean reciprocal rank), the "how high is the first good hit" companion.
 *
 * `runEval` intentionally does NOT record `relevant` on each per-query row, so
 * MRR is recomputed here from the dataset's gold set (keyed by query id) against
 * the retrieved list already captured in the report.
 */

/** One stratum's aggregate metrics (or the overall row). */
export interface StratumMetrics {
  /** 'lexical' | 'semantic' | 'untagged' | 'overall'. */
  stratum: string;
  queryCount: number;
  meanRecallAtK: number;
  meanNdcgAtK: number;
  /** Mean reciprocal rank of the first relevant hit. */
  mrr: number;
}

/** The full stratified view: overall + one row per observed `kind`. */
export interface StratifiedReport {
  dataset: string;
  backend: string;
  k: number;
  overall: StratumMetrics;
  byKind: StratumMetrics[];
}

function mean(nums: readonly number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((s, n) => s + n, 0) / nums.length;
}

/**
 * Build the stratified report. `goldById` maps each query id to its gold-relevant
 * id set so MRR can be recomputed against the retrieved lists in `report`.
 */
export function stratify(report: EvalReport, queries: readonly EvalQuery[]): StratifiedReport {
  const goldById = new Map<string, ReadonlySet<string>>(
    queries.map((q) => [q.id, new Set(q.relevant)]),
  );

  const rows = report.perQuery.map((r) => ({
    kind: r.kind ?? 'untagged',
    recall: r.recallAtK,
    ndcg: r.ndcgAtK,
    rr: reciprocalRank(r.retrieved, goldById.get(r.id) ?? new Set<string>()),
  }));

  const summarize = (stratum: string, subset: typeof rows): StratumMetrics => ({
    stratum,
    queryCount: subset.length,
    meanRecallAtK: mean(subset.map((x) => x.recall)),
    meanNdcgAtK: mean(subset.map((x) => x.ndcg)),
    mrr: mean(subset.map((x) => x.rr)),
  });

  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  return {
    dataset: report.dataset,
    backend: report.backend,
    k: report.k,
    overall: summarize('overall', rows),
    byKind: kinds.map((kind) =>
      summarize(
        kind,
        rows.filter((r) => r.kind === kind),
      ),
    ),
  };
}

/** Compact, human/CI-readable rendering of a stratified report. */
export function formatStratifiedReport(sr: StratifiedReport): string {
  const line = (m: StratumMetrics): string =>
    `  ${m.stratum.padEnd(9)} n=${String(m.queryCount).padStart(3)}  ` +
    `Recall@${sr.k}=${m.meanRecallAtK.toFixed(4)}  ` +
    `nDCG@${sr.k}=${m.meanNdcgAtK.toFixed(4)}  ` +
    `MRR=${m.mrr.toFixed(4)}`;
  return [
    `eval "${sr.dataset}" · backend=${sr.backend} @k=${sr.k}`,
    line(sr.overall),
    ...sr.byKind.map(line),
  ].join('\n');
}
