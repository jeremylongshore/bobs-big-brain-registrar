import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { computeContentHash, deriveAuditEventId } from '@qmd-team-intent-kb/common';
import { AuditEvent, Sensitivity, Sha256Hash, Uuid } from '@qmd-team-intent-kb/schema';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import type { AuditRepository } from '@qmd-team-intent-kb/store';

export const IMPORTED_FLOOR_KIND = 'imported-sensitivity-floor-v1';
export const SOURCE_IMPORT_ACTOR = { type: 'system' as const, id: 'governed-source-import' };

const ImportedFloor = z
  .object({
    kind: z.literal(IMPORTED_FLOOR_KIND),
    candidateId: Uuid,
    contentHash: Sha256Hash,
    minimumSensitivity: Sensitivity,
    importDigest: Sha256Hash,
    sourceSnapshotDigests: z.array(Sha256Hash).min(1).max(32),
  })
  .strict();

/** Only the transactional importer writes this receipt after source verification.
 * Receipt shape and content binding are checked again by every later promotion.
 * Local receipt integrity is not protection against an authorized database writer.
 */
export function importedMinimumSensitivity(
  event: AuditEvent,
  candidate: MemoryCandidate,
): Sensitivity {
  const details = ImportedFloor.parse(event.details);
  const sorted = [...new Set(details.sourceSnapshotDigests)].sort();
  if (
    event.action !== 'governed' ||
    event.memoryId !== candidate.id ||
    event.tenantId !== candidate.tenantId ||
    !isDeepStrictEqual(event.actor, SOURCE_IMPORT_ACTOR) ||
    details.candidateId !== candidate.id ||
    details.contentHash !== computeContentHash(candidate.content) ||
    event.id !==
      deriveAuditEventId(
        candidate.id,
        'governed',
        `${IMPORTED_FLOOR_KIND}:${details.importDigest}`,
      ) ||
    !isDeepStrictEqual(sorted, details.sourceSnapshotDigests)
  ) {
    throw new Error('Stored imported sensitivity constraint is invalid or content-mismatched');
  }
  return details.minimumSensitivity;
}

export function recordImportedMinimumSensitivity(
  candidate: MemoryCandidate,
  minimumSensitivity: Sensitivity,
  importDigest: string,
  sourceSnapshotDigests: string[],
  timestamp: string,
  audit: AuditRepository,
): AuditEvent {
  const details = ImportedFloor.parse({
    kind: IMPORTED_FLOOR_KIND,
    candidateId: candidate.id,
    contentHash: computeContentHash(candidate.content),
    minimumSensitivity,
    importDigest,
    sourceSnapshotDigests,
  });
  const event = AuditEvent.parse({
    id: deriveAuditEventId(candidate.id, 'governed', `${IMPORTED_FLOOR_KIND}:${importDigest}`),
    action: 'governed',
    memoryId: candidate.id,
    tenantId: candidate.tenantId,
    actor: SOURCE_IMPORT_ACTOR,
    timestamp,
    details,
    reason: 'Retain verified source restrictions and destination minimum sensitivity',
  });
  importedMinimumSensitivity(event, candidate);
  audit.insert(event);
  if (
    !isDeepStrictEqual(
      audit
        .findByMemoryAndTenant(candidate.id, candidate.tenantId)
        .find((row) => row.id === event.id),
      event,
    )
  ) {
    throw new Error('Imported sensitivity constraint receipt was not retained');
  }
  return event;
}
