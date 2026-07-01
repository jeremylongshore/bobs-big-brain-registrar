export { createDatabase, createTestDatabase } from './database.js';
export type { DatabaseOptions } from './database.js';
export { TABLE_DDL } from './schema.js';
export { CandidateRepository } from './repositories/candidate-repository.js';
export {
  assertEnumMembership,
  EnumConstraintViolationError,
} from './repositories/enum-membership.js';
export { MemoryRepository } from './repositories/memory-repository.js';
export { PolicyRepository } from './repositories/policy-repository.js';
export { AuditRepository } from './repositories/audit-repository.js';
export type { AuditChainRow } from './repositories/audit-repository.js';
export { verifyAuditChain, type AuditVerifyResult, type AuditChainBreak } from './audit-verify.js';
export { computeEntryHash, canonicalRowJson, CURRENT_AUDIT_HASH_VERSION } from './audit-chain.js';
export type { CanonicalAuditRow, AuditHashVersion } from './audit-chain.js';
export { appendAnchor, verifyAnchors, computeAnchorHash, readAnchors } from './audit-anchor.js';
export {
  computeManifestHash,
  readManifest,
  classifyChainBreaks,
  ExceptionManifestError,
} from './exception-manifest.js';
export type {
  ExceptionManifestEntry,
  ExceptionManifest,
  ExceptionManifestBody,
  StoredRowTuple,
  ClassifiedChainBreaks,
} from './exception-manifest.js';
export type {
  AnchorRecord,
  AnchorVerifyResult,
  AnchorBreak,
  AppendAnchorOptions,
} from './audit-anchor.js';
export {
  generateActorKeypair,
  signMergeAnchor,
  verifyMergeAnchorSignature,
  signedMergeAnchorBodyJson,
  computeSignedMergeAnchorHash,
  appendSignedMergeAnchor,
  readSignedMergeAnchors,
  verifySignedMergeAnchors,
} from './signed-merge-anchor.js';
export type {
  ActorKeypair,
  SignedMergeAnchorRecord,
  AppendSignedMergeAnchorOptions,
  SignedMergeAnchorBreak,
  SignedMergeAnchorVerifyResult,
} from './signed-merge-anchor.js';
export { verifyMergeAuditChain, canonicalMergeOrder } from './audit-verify-merge.js';
export type {
  MergeAuditVerifyResult,
  DagAnchorVerifyResult,
  DagAnchorBreak,
  VerifyMergeAuditChainInput,
} from './audit-verify-merge.js';
export { ExportStateRepository } from './repositories/export-state-repository.js';
export type { ExportState } from './repositories/export-state-repository.js';
export { MemoryLinksRepository } from './repositories/memory-links-repository.js';
export type { MemoryLink, Neighbor, GraphNode } from './repositories/memory-links-repository.js';
export { ImportBatchRepository } from './repositories/import-batch-repository.js';
export type { ImportBatch } from './repositories/import-batch-repository.js';
