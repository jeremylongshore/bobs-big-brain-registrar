export type { CurationResult, CurationBatchResult, CuratorConfig } from './types.js';
export { Curator } from './curator.js';
export type { CuratorDependencies } from './curator.js';
export { ingestFromSpool, ingestFromSpoolDetailed } from './intake/spool-intake.js';
export type {
  IngestFromSpoolOptions,
  IngestResult,
  SpoolTamperRecord,
  SpoolDisclosureRejection,
} from './intake/spool-intake.js';
export { checkDuplicate } from './dedup/dedup-checker.js';
export type { DedupResult } from './dedup/dedup-checker.js';
export {
  detectSupersession,
  computeTitleSimilarity,
} from './supersession/supersession-detector.js';
export type { SupersessionMatch } from './supersession/supersession-detector.js';
export { promote } from './promotion/promoter.js';
export type { PromotionInput } from './promotion/promoter.js';
export { reject } from './rejection/rejector.js';
export { mergeGovern, MergeIdInvariantError } from './merge/merge-gate.js';
export type {
  MergeGovernResult,
  MergeGovernDependencies,
  MergeGovernOptions,
  QuarantinedRow,
  QuarantineCategory,
} from './merge/merge-gate.js';
export { parseMarkdown, titleFromPath, walkVault, countVaultFiles } from './import/index.js';
export type { ParsedMarkdown, VaultFile } from './import/index.js';
export {
  detectCollision,
  previewImport,
  executeImport,
  rollbackImport,
  extractWikiLinks,
  resolveWikiLinks,
} from './import/index.js';
export type {
  CollisionResult,
  CollisionTarget,
  ImportFileResult,
  ImportPreviewResult,
  ImportExecutionResult,
  ImportDependencies,
  RollbackResult,
} from './import/index.js';
