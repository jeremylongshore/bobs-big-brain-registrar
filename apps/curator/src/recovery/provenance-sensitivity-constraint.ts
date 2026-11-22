import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { computeContentHash, deriveAuditEventId } from '@qmd-team-intent-kb/common';
import { Sensitivity, Sha256Hash, Uuid } from '@qmd-team-intent-kb/schema';
import type { AuditEvent, MemoryCandidate } from '@qmd-team-intent-kb/schema';

export const PROVENANCE_FLOOR_KIND = 'provenance-sensitivity-floor-v1';
export const PROVENANCE_FLOOR_ACTOR = { type: 'system' as const, id: 'source-provenance-governor' };
// Replay event identity deliberately excludes candidate ID: reusing an assertion
// ID for a different candidate must collide and refuse, not create another event.
const REPLAY_NAMESPACE = 'b0cb10da-1977-4aad-9dc3-3b862f72cdac';

export const ProvenanceFloor = z
  .object({
    kind: z.literal(PROVENANCE_FLOOR_KIND),
    candidateId: Uuid,
    contentHash: Sha256Hash,
    minimumSensitivity: Sensitivity,
    candidateSnapshotDigest: Sha256Hash,
    assertionDigest: Sha256Hash,
    profileDigest: Sha256Hash,
    registryDigest: Sha256Hash,
    enrollmentRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    replayIdentity: Sha256Hash,
    producerDigest: Sha256Hash,
    keyDigest: Sha256Hash,
  })
  .strict();
export type ProvenanceFloor = z.infer<typeof ProvenanceFloor>;

export function provenanceFloorEventId(replayIdentity: string): string {
  return deriveAuditEventId(
    REPLAY_NAMESPACE,
    'governed',
    `${PROVENANCE_FLOOR_KIND}:${Sha256Hash.parse(replayIdentity)}`,
  );
}

/** Validate settled evidence without consulting today's registry. Expiry,
 * revocation or deletion cannot erase an already recorded privacy restriction.
 * As elsewhere, local receipts provide tamper evidence, not protection from a
 * database owner who rewrites the data and recomputes its chain.
 */
export function provenanceMinimumSensitivity(
  event: AuditEvent,
  candidate: MemoryCandidate,
): Sensitivity {
  const details = ProvenanceFloor.parse(event.details);
  if (
    event.action !== 'governed' ||
    event.memoryId !== candidate.id ||
    event.tenantId !== candidate.tenantId ||
    details.candidateId !== candidate.id ||
    details.contentHash !== computeContentHash(candidate.content) ||
    !isDeepStrictEqual(event.actor, PROVENANCE_FLOOR_ACTOR) ||
    event.id !== provenanceFloorEventId(details.replayIdentity)
  )
    throw new Error('Stored provenance sensitivity constraint is invalid or content-mismatched');
  return details.minimumSensitivity;
}
