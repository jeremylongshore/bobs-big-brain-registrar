import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { deriveAuditEventId, deriveMemoryId } from '@qmd-team-intent-kb/common';
import { AuditEvent, Sha256Hash } from '@qmd-team-intent-kb/schema';
import type { AuditRepository } from '@qmd-team-intent-kb/store';
import { SOURCE_IMPORT_ACTOR } from '../recovery/imported-sensitivity-constraint.js';
import { SourceImportError, SourceImportOutcome } from './source-import-schema.js';
import type { SourceImportPlan, SourceImportResult } from './source-import-schema.js';
import { sourceSnapshotDigest, SourceSnapshotOptions } from './source-snapshot-schema.js';
import type { SignedSourceSnapshot } from './source-snapshot-schema.js';

const ACCEPTED = 'source-snapshot-accepted-v1';
const SETTLED = 'source-import-settled-v1';
const Accepted = SourceSnapshotOptions.pick({
  sourceId: true,
  sourceTenantId: true,
  destinationTenantId: true,
  sequence: true,
})
  .extend({
    kind: z.literal(ACCEPTED),
    keyId: Sha256Hash,
    snapshotDigest: Sha256Hash,
    importDigest: Sha256Hash,
  })
  .strict();
const Settled = z
  .object({
    kind: z.literal(SETTLED),
    importDigest: Sha256Hash,
    policyDigest: Sha256Hash,
    sourceSnapshotDigests: z.array(Sha256Hash).min(1).max(32),
    outcomes: z.array(SourceImportOutcome).max(10_000),
  })
  .strict();

export function requireRetainedEvent(event: AuditEvent, audit: AuditRepository): void {
  if (
    !isDeepStrictEqual(
      event,
      audit
        .findByMemoryAndTenant(event.memoryId, event.tenantId)
        .find((row) => row.id === event.id),
    )
  ) {
    throw new SourceImportError('retention-failed');
  }
}

function streamIdentity(snapshot: SignedSourceSnapshot): {
  sourceId: string;
  sourceTenantId: string;
  destinationTenantId: string;
} {
  const { sourceId, sourceTenantId, destinationTenantId } = snapshot.payload;
  return { sourceId, sourceTenantId, destinationTenantId };
}

function streamId(snapshot: SignedSourceSnapshot): string {
  // Key rotations share a monotonic sequence space; changing keys cannot reset it.
  return deriveMemoryId(ACCEPTED, sourceSnapshotDigest(streamIdentity(snapshot)));
}

/** Returns the existing same-checkpoint receipt, or undefined for a forward step. */
export function inspectSourceProgress(
  snapshot: SignedSourceSnapshot,
  audit: AuditRepository,
): AuditEvent | undefined {
  const identity = streamIdentity(snapshot);
  const memoryId = streamId(snapshot);
  let latest: { event: AuditEvent; details: z.infer<typeof Accepted> } | undefined;
  for (const event of audit.findByMemoryAndTenant(memoryId, identity.destinationTenantId)) {
    const details = Accepted.parse(event.details);
    if (
      event.action !== 'governed' ||
      !isDeepStrictEqual(event.actor, SOURCE_IMPORT_ACTOR) ||
      details.sourceId !== identity.sourceId ||
      details.sourceTenantId !== identity.sourceTenantId ||
      details.destinationTenantId !== identity.destinationTenantId ||
      event.id !== deriveAuditEventId(memoryId, 'governed', `${ACCEPTED}:${details.sequence}`)
    ) {
      throw new SourceImportError('invalid-destination');
    }
    if (latest === undefined || details.sequence > latest.details.sequence)
      latest = { event, details };
  }
  if (latest === undefined) return undefined;
  if (
    snapshot.payload.sequence < latest.details.sequence ||
    (snapshot.payload.sequence === latest.details.sequence &&
      (snapshot.digest !== latest.details.snapshotDigest ||
        snapshot.payload.keyId !== latest.details.keyId))
  ) {
    throw new SourceImportError('stale-source');
  }
  return snapshot.payload.sequence === latest.details.sequence ? latest.event : undefined;
}

export function recordSourceProgress(
  snapshot: SignedSourceSnapshot,
  plan: SourceImportPlan,
  timestamp: string,
  audit: AuditRepository,
): AuditEvent {
  const previous = inspectSourceProgress(snapshot, audit);
  if (previous !== undefined) return previous;
  const memoryId = streamId(snapshot);
  const event = AuditEvent.parse({
    id: deriveAuditEventId(memoryId, 'governed', `${ACCEPTED}:${snapshot.payload.sequence}`),
    memoryId,
    tenantId: plan.tenantId,
    action: 'governed',
    actor: SOURCE_IMPORT_ACTOR,
    timestamp,
    reason: 'Accept a verified source snapshot checkpoint',
    details: Accepted.parse({
      ...streamIdentity(snapshot),
      kind: ACCEPTED,
      sequence: snapshot.payload.sequence,
      keyId: snapshot.payload.keyId,
      snapshotDigest: snapshot.digest,
      importDigest: plan.importDigest,
    }),
  });
  audit.insert(event);
  requireRetainedEvent(event, audit);
  return event;
}

function batchId(plan: SourceImportPlan): string {
  return deriveMemoryId(SETTLED, plan.importDigest);
}

export function readImportSettlement(
  plan: SourceImportPlan,
  audit: AuditRepository,
): SourceImportResult | undefined {
  const rows = audit.findByMemoryAndTenant(batchId(plan), plan.tenantId);
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) throw new SourceImportError('invalid-destination');
  const event = rows[0]!;
  const details = Settled.parse(event.details);
  if (
    event.id !== deriveAuditEventId(batchId(plan), 'governed', SETTLED) ||
    event.action !== 'governed' ||
    !isDeepStrictEqual(event.actor, SOURCE_IMPORT_ACTOR) ||
    details.importDigest !== plan.importDigest ||
    details.policyDigest !== plan.policyDigest ||
    !isDeepStrictEqual(details.sourceSnapshotDigests, plan.sourceSnapshotDigests)
  ) {
    throw new SourceImportError('invalid-destination');
  }
  return { importDigest: plan.importDigest, alreadyApplied: true, outcomes: details.outcomes };
}

export function recordImportSettlement(
  plan: SourceImportPlan,
  outcomes: SourceImportOutcome[],
  timestamp: string,
  audit: AuditRepository,
): AuditEvent {
  const memoryId = batchId(plan);
  const event = AuditEvent.parse({
    id: deriveAuditEventId(memoryId, 'governed', SETTLED),
    memoryId,
    tenantId: plan.tenantId,
    action: 'governed',
    actor: SOURCE_IMPORT_ACTOR,
    timestamp,
    reason: 'Settle governed source import',
    details: Settled.parse({
      kind: SETTLED,
      importDigest: plan.importDigest,
      policyDigest: plan.policyDigest,
      sourceSnapshotDigests: plan.sourceSnapshotDigests,
      outcomes,
    }),
  });
  audit.insert(event);
  requireRetainedEvent(event, audit);
  return event;
}
