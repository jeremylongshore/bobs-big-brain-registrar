import { z } from 'zod';
import { Sensitivity, Sha256Hash, Uuid } from '@qmd-team-intent-kb/schema';
import type { GovernancePolicy } from '@qmd-team-intent-kb/schema';
import type { AuditRepository, MemoryRepository } from '@qmd-team-intent-kb/store';
import type { TrustedSourceCheckpoint } from './source-snapshot-schema.js';

export const MAX_IMPORT_SOURCES = 32;
export const SourceImportPlan = z
  .object({
    version: z.literal(1),
    tenantId: z.string().trim().min(1),
    importDigest: Sha256Hash,
    destinationDigest: Sha256Hash,
    authorityDigest: Sha256Hash,
    policyDigest: Sha256Hash,
    sourceSnapshotDigests: z.array(Sha256Hash).min(1).max(MAX_IMPORT_SOURCES),
  })
  .strict();
export type SourceImportPlan = z.infer<typeof SourceImportPlan>;

export const SourceImportOutcome = z
  .object({
    candidateId: Uuid,
    memoryId: Uuid,
    contentHash: Sha256Hash,
    minimumSensitivity: Sensitivity,
    sensitivity: Sensitivity,
    status: z.enum(['promoted', 'existing', 'deduplicated', 'rejected']),
    reason: z.string().optional(),
  })
  .strict();
export type SourceImportOutcome = z.infer<typeof SourceImportOutcome>;

export interface SourceImportContext {
  tenantId: string;
  /** Trusted local authorization provider, reloaded inside the transaction and before commit.
   * This is not caller-controlled artifact data or an enrollment endpoint.
   */
  loadCheckpoints: () => readonly TrustedSourceCheckpoint[];
  /** Trusted clock; validity is checked again before committing. */
  now: () => number;
  policy?: GovernancePolicy;
}
export interface SourceImportDependencies {
  memoryRepo: MemoryRepository;
  auditRepo: AuditRepository;
}
export interface SourceImportResult {
  importDigest: string;
  /** Historical settlement, not a claim that a previously admitted row is still active. */
  alreadyApplied: boolean;
  outcomes: SourceImportOutcome[];
}

export class SourceImportError extends Error {
  constructor(
    readonly code:
      | 'invalid-input'
      | 'invalid-destination'
      | 'stale-plan'
      | 'stale-source'
      | 'conflicting-content'
      | 'retention-failed',
  ) {
    super(`Source import refused: ${code}`);
    this.name = 'SourceImportError';
  }
}
