export { createDatabase, createTestDatabase } from './database.js';
export type { DatabaseOptions } from './database.js';
export { TABLE_DDL } from './schema.js';
export { CandidateRepository } from './repositories/candidate-repository.js';
export { MemoryRepository } from './repositories/memory-repository.js';
export { PolicyRepository } from './repositories/policy-repository.js';
export { AuditRepository } from './repositories/audit-repository.js';
export type { AuditChainRow } from './repositories/audit-repository.js';
export { verifyAuditChain, type AuditVerifyResult, type AuditChainBreak } from './audit-verify.js';
export { computeEntryHash, canonicalRowJson } from './audit-chain.js';
export type { CanonicalAuditRow } from './audit-chain.js';
export { appendAnchor, verifyAnchors, computeAnchorHash, readAnchors } from './audit-anchor.js';
export type {
  AnchorRecord,
  AnchorVerifyResult,
  AnchorBreak,
  AppendAnchorOptions,
} from './audit-anchor.js';
export { ExportStateRepository } from './repositories/export-state-repository.js';
export type { ExportState } from './repositories/export-state-repository.js';
export { MemoryLinksRepository } from './repositories/memory-links-repository.js';
export type { MemoryLink, Neighbor, GraphNode } from './repositories/memory-links-repository.js';
export { ImportBatchRepository } from './repositories/import-batch-repository.js';
export type { ImportBatch } from './repositories/import-batch-repository.js';
