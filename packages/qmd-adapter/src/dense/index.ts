export {
  EmbedClient,
  denseScore,
  DEFAULT_EMBED_TIMEOUT_MS,
  EMBEDDINGGEMMA_QUERY_PREFIX,
  EMBEDDINGGEMMA_DOCUMENT_PREFIX,
} from './embed-client.js';
export type { DenseScore, EmbedRole, EmbedClientOptions } from './embed-client.js';

export { DenseVecIndex, DENSE_SNIPPET_CHARS } from './dense-index.js';
export type { DenseSearchHit, DenseDocEntry } from './dense-index.js';

export {
  DenseIndexer,
  DEFAULT_DENSE_MAX_DOC_CHARS,
  DEFAULT_DENSE_BATCH_SIZE,
} from './dense-indexer.js';
export type { DenseIndexReport, DenseIndexerOptions } from './dense-indexer.js';
