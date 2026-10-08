export { scrubIndexes } from './index-scrub.js';
export type {
  IndexScrubOptions,
  IndexScrubReport,
  IndexFileReport,
  IndexFileStatus,
  IndexFragmentScan,
  TenantScrubReport,
} from './index-scrub.js';
export type { RemovalCounts } from './index-files.js';
export {
  PINNED_QMD_VERSION,
  QMD_INDEX_SCHEMA,
  NATIVE_INDEX_SCHEMA,
  DENSE_INDEX_SCHEMA,
  checkSchema,
} from './schema-guard.js';
export type { TableShape } from './schema-guard.js';
export { indexScrubJson, formatIndexScrub } from './format.js';
export { readFragmentsFile } from './fragments-file.js';
