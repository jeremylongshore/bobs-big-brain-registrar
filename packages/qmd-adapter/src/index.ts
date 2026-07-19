// Types
export type { QmdError, CommandResult, QmdHealthStatus, QmdSearchResult } from './types.js';

// Config
export type { QmdAdapterConfig } from './config.js';
export {
  QMD_INDEX_DIR,
  getQmdIndexBasePath,
  getQmdTenantIndexPath,
  getQmdCollectionIndexPath,
  getQmdTenantEnv,
  DEFAULT_QMD_BINARY,
  DEFAULT_TIMEOUT,
} from './config.js';

// Executor
export type { QmdExecutor } from './executor/executor.js';
export { RealQmdExecutor } from './executor/real-executor.js';
export { MockQmdExecutor } from './executor/mock-executor.js';

// Collections
export type { CollectionDef } from './collections/collection-registry.js';
export {
  KNOWN_COLLECTIONS,
  getDefaultSearchCollections,
  getAllCollectionNames,
  getExportableCollections,
  isKnownCollection,
  isDefaultSearchCollection,
} from './collections/collection-registry.js';
export { CollectionManager } from './collections/collection-manager.js';

// Index management
export { getTenantDataDir, getCollectionDataDir } from './index-manager/index-paths.js';
export { IndexLifecycleManager } from './index-manager/index-lifecycle.js';

// Search
export { SearchClient } from './search/search-client.js';
export { parseQueryOutput, deriveCollectionFromPath } from './search/result-parser.js';

// Health
export { checkHealth } from './health/health-check.js';

// Facade
export { QmdAdapter } from './adapter.js';

// Weights — retrieval-model integrity pinning (bead 0t9.5)
export {
  verifyWeights,
  assertWeightsVerified,
  resolveQmdModelsDir,
  WeightIntegrityError,
  QMD_WEIGHTS_MANIFEST,
} from './weights/index.js';
export type {
  PinnedModel,
  WeightsManifest,
  ModelVerifyStatus,
  ModelVerifyResult,
  WeightsVerifyResult,
} from './weights/index.js';

// Eval — retrieval-quality harness, gates BM25 vs native semantic (bead 0t9.6)
export {
  recallAtK,
  ndcgAtK,
  reciprocalRank,
  runEval,
  formatReport,
  bm25IsSufficient,
  BM25_SUFFICIENCY_RECALL_THRESHOLD,
  SEED_EVAL_DATASET,
} from './eval/index.js';
export type {
  EvalQuery,
  EvalDataset,
  RetrievalFn,
  QueryEvalResult,
  EvalReport,
} from './eval/index.js';

// Native FTS5 — model-free keyword backend, no external binary (bead 0t9.2)
export {
  Fts5Backend,
  fts5RetrievalFn,
  buildFts5MatchQuery,
  NativeIndexManager,
  getNativeIndexManager,
} from './native/index.js';
export { fuseReciprocalRank, RRF_K } from './search/rrf-fusion.js';
export { resolveScopeCollections } from './search/search-client.js';
export type { IndexedDoc, Fts5SearchHit } from './native/index.js';

// Rerank — opt-in local cross-encoder stage, fail-open to the fused order (B1, 044-AT-DECR)
export {
  RerankClient,
  RerankCache,
  RerankStage,
  rerankScore,
  resolveCitationPath,
  DEFAULT_RERANK_TIMEOUT_MS,
  DEFAULT_CANDIDATE_WINDOW,
  DEFAULT_RERANK_TOP_N,
  DEFAULT_MAX_DOC_CHARS,
} from './rerank/index.js';
export type {
  RerankScore,
  RerankScoredDoc,
  RerankClientOptions,
  RerankStageOptions,
} from './rerank/index.js';

// Reindex — idempotent rebuild of the derived qmd-index from kb-export (e06.13)
export { reindex } from './reindex/reindex.js';
export type { ReindexReport } from './reindex/reindex.js';

// Search-health canary — fails loudly when a known-positive control returns 0 hits (e06.13)
export {
  runSearchCanary,
  formatCanaryReport,
  DEFAULT_CANARY_CONTROLS,
} from './canary/search-canary.js';
export type {
  CanaryControl,
  CanaryControlResult,
  SearchCanaryReport,
  SearchCanaryOptions,
} from './canary/search-canary.js';
