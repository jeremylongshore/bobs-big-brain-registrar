import { z } from 'zod';
import { Sensitivity, Sha256Hash, TenantId, Uuid } from '@qmd-team-intent-kb/schema';

export const SourceGovernancePlan = z
  .object({
    version: z.literal(1),
    candidateId: Uuid,
    tenantId: TenantId,
    receiverId: z.string().min(1).max(128),
    ingressId: z.string().min(1).max(128),
    envelopeDigest: Sha256Hash,
    candidateSnapshotDigest: Sha256Hash,
    assertionDigest: Sha256Hash,
    replayIdentity: Sha256Hash,
    authorityDigest: Sha256Hash,
    policyDigest: Sha256Hash,
    configDigest: Sha256Hash,
    stateDigest: Sha256Hash,
    minimumSensitivity: Sensitivity,
    restrictionOnly: z.boolean(),
    policyOutcome: z.enum(['approved', 'flagged', 'rejected']),
  })
  .strict();
export type SourceGovernancePlan = z.infer<typeof SourceGovernancePlan>;
export const SourceGovernanceSettlement = z
  .object({
    kind: z.literal('source-governance-settlement-v1'),
    plan: SourceGovernancePlan,
    outcome: z.enum([
      'promoted',
      'rejected',
      'flagged',
      'duplicate',
      'held',
      'quarantined',
      'restricted-existing',
    ]),
    memoryId: Uuid.nullable(),
  })
  .strict();
export type SourceGovernanceSettlement = z.infer<typeof SourceGovernanceSettlement>;
/** Trusted integration supplies receiver identity and a fresh clock, never request fields.
 * The registry is always loaded from the governed store.
 */
export interface SourceGovernanceContext {
  readReceiver(): unknown;
  originSecret?: string;
}
