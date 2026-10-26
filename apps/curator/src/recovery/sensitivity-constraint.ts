import { isDeepStrictEqual } from 'node:util';
import { computeContentHash, deriveAuditEventId } from '@qmd-team-intent-kb/common';
import { effectiveSensitivity } from '@qmd-team-intent-kb/policy-engine';
import { AuditEvent, Sensitivity, Sha256Hash, Uuid } from '@qmd-team-intent-kb/schema';
import type { Author, MemoryCandidate } from '@qmd-team-intent-kb/schema';
import type { AuditRepository } from '@qmd-team-intent-kb/store';

const KIND = 'recovery-sensitivity-floor-v1';

/** Resolve durable constraints in this store, including later human review.
 * Invalid or content-mismatched constraint receipts refuse instead of dropping
 * a privacy bound. This does not import constraint receipts from remote clones.
 */
export function resolveCandidateMinimumSensitivity(
  candidate: MemoryCandidate,
  audit: AuditRepository,
): Sensitivity | undefined {
  let minimum: Sensitivity | undefined;
  for (const event of audit.findByMemoryAndTenant(candidate.id, candidate.tenantId)) {
    if (event.action !== 'governed' || event.details['kind'] !== KIND) continue;
    const floor = Sensitivity.parse(event.details['minimumSensitivity']);
    Uuid.parse(event.details['runId']);
    Sha256Hash.parse(event.details['candidateSnapshotDigest']);
    Sha256Hash.parse(event.details['manifestDigest']);
    if (
      event.details['contentHash'] !== computeContentHash(candidate.content) ||
      event.details['candidateId'] !== candidate.id ||
      event.actor.type !== 'human' ||
      (event.details['resolverRole'] !== 'admin' && event.details['resolverRole'] !== 'owner')
    ) {
      throw new Error('Stored recovery sensitivity constraint is invalid or content-mismatched');
    }
    minimum = minimum === undefined ? floor : effectiveSensitivity(minimum, floor);
  }
  return minimum;
}

/** Internal selected-governance write; the enclosing immediate transaction owns
 * authority, snapshot validation and rollback with its final batch receipt.
 */
export function recordCandidateMinimumSensitivity(
  candidate: MemoryCandidate,
  minimum: Sensitivity,
  context: {
    runId: string;
    manifestDigest: string;
    candidateSnapshotDigest: string;
    actor: Author;
    role: 'admin' | 'owner';
    reason: string;
  },
  audit: AuditRepository,
): void {
  Sensitivity.parse(minimum);
  const previous = resolveCandidateMinimumSensitivity(candidate, audit);
  if (previous !== undefined && effectiveSensitivity(previous, minimum) === previous) return;
  const event = AuditEvent.parse({
    id: deriveAuditEventId(candidate.id, 'governed', `${KIND}:${context.runId}`),
    action: 'governed',
    memoryId: candidate.id,
    tenantId: candidate.tenantId,
    actor: context.actor,
    reason: context.reason,
    timestamp: new Date().toISOString(),
    details: {
      kind: KIND,
      candidateId: candidate.id,
      contentHash: computeContentHash(candidate.content),
      minimumSensitivity: minimum,
      runId: context.runId,
      manifestDigest: context.manifestDigest,
      candidateSnapshotDigest: context.candidateSnapshotDigest,
      resolverRole: context.role,
    },
  });
  audit.insert(event);
  const stored = audit
    .findByMemoryAndTenant(candidate.id, candidate.tenantId)
    .find((item) => item.id === event.id);
  if (!isDeepStrictEqual(stored, event))
    throw new Error('Recovery sensitivity constraint receipt was not retained');
}
