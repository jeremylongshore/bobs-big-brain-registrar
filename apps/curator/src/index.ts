export type {
  CurationResult,
  CurationBatchResult,
  CuratorConfig,
  SupersessionReport,
} from './types.js';
export { Curator } from './curator.js';
export type { CuratorDependencies } from './curator.js';
export { ingestFromSpool, ingestFromSpoolDetailed } from './intake/spool-intake.js';
export type {
  IngestFromSpoolOptions,
  IngestResult,
  SpoolTamperRecord,
  SpoolDisclosureRejection,
  SpoolAdmissionRejection,
} from './intake/spool-intake.js';
export { checkDuplicate } from './dedup/dedup-checker.js';
export type { DedupResult } from './dedup/dedup-checker.js';
export {
  detectSupersession,
  planSupersession,
  DEFAULT_MAX_SUPERSEDES_PER_PROMOTION,
  computeTitleSimilarity,
  DEFAULT_SUPERSESSION_THRESHOLD,
} from './supersession/supersession-detector.js';
export type { SupersessionMatch, SupersessionPlan } from './supersession/supersession-detector.js';
export { promote } from './promotion/promoter.js';
export type { PromotionInput } from './promotion/promoter.js';
export { reject } from './rejection/rejector.js';
export { checkOriginAttestation, ORIGIN_ATTESTATION_RULE_TYPE } from './origin/origin-gate.js';
export type { OriginGateResult, OriginRejectCode } from './origin/origin-gate.js';
export {
  checkImportExclusion,
  IMPORT_EXCLUSION_RULE_TYPE,
} from './import-exclusion/import-exclusion-gate.js';
export type { ImportExclusionResult } from './import-exclusion/import-exclusion-gate.js';
export {
  DEFAULT_BRAINIGNORE_PATTERNS,
  DEFAULT_BRAINIGNORE_RULESET,
  compilePattern,
  parseBrainignore,
  matchPath,
  analyzeContent,
  evaluateBrainignore,
  shannonEntropy,
} from './import-exclusion/brainignore.js';
export type {
  BrainignorePattern,
  BrainignoreRuleset,
  BrainignoreMatch,
} from './import-exclusion/brainignore.js';
export {
  loadBrainignoreRuleset,
  defaultBrainignorePath,
  BRAINIGNORE_PATH_ENV,
} from './import-exclusion/load-brainignore.js';
export type { LoadBrainignoreOptions } from './import-exclusion/load-brainignore.js';
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
export { narrowAudience } from './audience/narrow-audience.js';
export type {
  NarrowAudienceInput,
  NarrowAudienceResult,
  NarrowAudienceRefusalCode,
} from './audience/narrow-audience.js';
export { redactMemory, REDACTION_MARKER } from './redaction/redact-memory.js';
export type {
  RedactMemoryInput,
  RedactMemoryResult,
  RedactMemoryOutcome,
  RedactionMode,
  RedactionSpan,
  RedactionRefusalCode,
  RedactionDependencies,
} from './redaction/redact-memory.js';
