export { recallAtK, ndcgAtK, reciprocalRank } from './metrics.js';
export {
  runEval,
  formatReport,
  bm25IsSufficient,
  BM25_SUFFICIENCY_RECALL_THRESHOLD,
} from './run-eval.js';
export type {
  EvalQuery,
  EvalDataset,
  RetrievalFn,
  QueryEvalResult,
  EvalReport,
} from './eval-types.js';
export { SEED_EVAL_DATASET } from './datasets/seed-queries.js';
export { stratify, formatStratifiedReport } from './stratified-report.js';
export type { StratumMetrics, StratifiedReport } from './stratified-report.js';
export { qmdRetrievalFn } from './qmd-retrieval.js';
export { GOVERNED_BRAIN_V1_DATASET } from './datasets/governed-brain-v1.js';
export {
  SYNTHETIC_V1_DATASET,
  SYNTHETIC_V1_BASELINE,
  RATCHET_EPSILON,
} from './datasets/synthetic-v1.js';
