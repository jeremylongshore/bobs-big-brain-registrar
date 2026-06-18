/**
 * Types for the retrieval eval harness (bead 0t9.6).
 *
 * The harness runs a labeled query set through a retrieval backend and reports
 * mean Recall@k + nDCG@k — the gate for BM25-vs-native-semantic. The doc
 * identifiers in `relevant` MUST be in the same id space the `RetrievalFn`
 * returns (for qmd that is the `qmd://` citation / `QmdSearchResult.file`).
 */

/** One eval query with its hand-labeled gold-relevant doc ids. */
export interface EvalQuery {
  id: string;
  query: string;
  /** Gold-relevant doc identifiers (same id space as RetrievalFn output). */
  relevant: string[];
  /** Which class this query stresses — lexical (exact terms) vs semantic (paraphrase). */
  kind?: 'lexical' | 'semantic';
  notes?: string;
}

/** A labeled eval dataset. */
export interface EvalDataset {
  name: string;
  /** What the doc identifiers are, e.g. "qmd:// citation". */
  idSpace: string;
  queries: EvalQuery[];
}

/** A retrieval backend under test: query → ranked doc ids (best first), top-k. */
export type RetrievalFn = (query: string, k: number) => Promise<string[]>;

/** Per-query eval result. */
export interface QueryEvalResult {
  id: string;
  query: string;
  kind?: 'lexical' | 'semantic';
  retrieved: string[];
  recallAtK: number;
  ndcgAtK: number;
}

/** Aggregate eval report for one backend over one dataset. */
export interface EvalReport {
  dataset: string;
  backend: string;
  k: number;
  queryCount: number;
  meanRecallAtK: number;
  meanNdcgAtK: number;
  perQuery: QueryEvalResult[];
}
