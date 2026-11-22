import { isDeepStrictEqual } from 'node:util';
import { deriveAuditEventId } from '@qmd-team-intent-kb/common';
import { effectiveSensitivity } from '@qmd-team-intent-kb/policy-engine';
import { AuditEvent } from '@qmd-team-intent-kb/schema';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import {
  PROVENANCE_FLOOR_ACTOR,
  ProvenanceFloor,
  provenanceFloorEventId,
} from '../recovery/provenance-sensitivity-constraint.js';
import {
  SourceGovernanceSettlement,
  type SourceGovernancePlan,
} from './source-governance-schema.js';
import {
  sourceGovernanceDigest,
  type sourceGovernanceRepositories,
} from './source-governance-prepare.js';

type Repos = ReturnType<typeof sourceGovernanceRepositories>;
export function sourceSettlementId(plan: Pick<SourceGovernancePlan, 'replayIdentity'>): string {
  return deriveAuditEventId(
    provenanceFloorEventId(plan.replayIdentity),
    'governed',
    'source-governance-settlement-v1',
  );
}
export function readSourceSettlement(
  plan: SourceGovernancePlan,
  deps: Repos,
): SourceGovernanceSettlement | undefined {
  const event = deps.auditRepo
    .findByTenantAndAction(plan.tenantId, 'governed')
    .find((e) => e.id === sourceSettlementId(plan));
  if (!event) {
    const orphan = deps.auditRepo
      .findByTenantAndAction(plan.tenantId, 'governed')
      .find((e) => e.id === provenanceFloorEventId(plan.replayIdentity));
    if (orphan) throw new Error('Incomplete source governance settlement');
    return undefined;
  }
  const settled = SourceGovernanceSettlement.parse(event.details);
  if (
    event.memoryId !== settled.plan.candidateId ||
    event.tenantId !== settled.plan.tenantId ||
    !isDeepStrictEqual(event.actor, PROVENANCE_FLOOR_ACTOR) ||
    sourceSettlementId(settled.plan) !== event.id
  )
    throw new Error('Invalid source settlement');
  const floorEvent = deps.auditRepo
    .findByMemoryAndTenant(settled.plan.candidateId, settled.plan.tenantId)
    .find((e) => e.id === provenanceFloorEventId(settled.plan.replayIdentity));
  if (!floorEvent || !isDeepStrictEqual(floorEvent.actor, PROVENANCE_FLOOR_ACTOR))
    throw new Error('Missing source floor settlement evidence');
  const floor = ProvenanceFloor.parse(floorEvent.details);
  if (
    floor.assertionDigest !== settled.plan.assertionDigest ||
    floor.candidateSnapshotDigest !== settled.plan.candidateSnapshotDigest ||
    floor.minimumSensitivity !== settled.plan.minimumSensitivity
  )
    throw new Error('Source settlement floor mismatch');
  if (!isDeepStrictEqual(plan, settled.plan)) throw new Error('Source assertion replay mismatch');
  return settled;
}
export function requireSourceEvent(event: AuditEvent, deps: Repos): void {
  const actual = deps.auditRepo
    .findByMemoryAndTenant(event.memoryId, event.tenantId)
    .find((e) => e.id === event.id);
  if (!isDeepStrictEqual(actual, event))
    throw new Error('Source governance receipt was not retained');
}
export function tightenSourceAliases(
  rows: CuratedMemory[],
  plan: SourceGovernancePlan,
  timestamp: string,
  deps: Repos,
) {
  const events: AuditEvent[] = [];
  const changed: CuratedMemory[] = [];
  for (const row of rows) {
    const sensitivity = effectiveSensitivity(row.sensitivity, plan.minimumSensitivity);
    if (sensitivity === row.sensitivity) continue;
    const updated = { ...row, sensitivity, version: row.version + 1, updatedAt: timestamp };
    if (!deps.memoryRepo.update(updated)) throw new Error('Source alias tightening failed');
    const event = AuditEvent.parse({
      id: deriveAuditEventId(
        row.id,
        'governed',
        `source-provenance-tightening-v1:${plan.replayIdentity}`,
      ),
      action: 'governed',
      memoryId: row.id,
      tenantId: row.tenantId,
      actor: PROVENANCE_FLOOR_ACTOR,
      timestamp,
      reason: 'Tighten existing content alias to authenticated source restriction',
      details: {
        kind: 'source-provenance-tightening-v1',
        replayIdentity: plan.replayIdentity,
        contentHash: row.contentHash,
        previousSensitivity: row.sensitivity,
        sensitivity,
      },
    });
    deps.auditRepo.insert(event);
    events.push(event);
    changed.push(updated);
  }
  return { events, changed };
}
export function requireSourceRows(rows: CuratedMemory[], deps: Repos): void {
  for (const row of rows)
    if (sourceGovernanceDigest(deps.memoryRepo.findById(row.id)) !== sourceGovernanceDigest(row))
      throw new Error('Source alias restriction was not retained');
}
