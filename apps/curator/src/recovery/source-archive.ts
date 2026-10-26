import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  computeContentHash,
  deriveAuditEventId,
  isAudienceVisibleToRole,
} from '@qmd-team-intent-kb/common';
import {
  AuditEvent,
  Author,
  CuratedMemory,
  Sha256Hash,
  TenantId,
  Uuid,
} from '@qmd-team-intent-kb/schema';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { AuditRepository, CandidateRepository, MemoryRepository } from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';

import { candidateSnapshotDigest } from './selected-governance.js';

export interface RecoverySnapshotBinding {
  id: string;
  snapshotDigest: string;
}

export interface RecoverySourceArchiveInput {
  runId: string;
  sourceTenantId: string;
  targetTenantId: string;
  source: RecoverySnapshotBinding;
  target: RecoverySnapshotBinding;
  candidate: RecoverySnapshotBinding;
  promotionReceipt: RecoverySnapshotBinding;
  settlementReceipt: RecoverySnapshotBinding;
  /** Caller establishes identity and authority in BOTH tenants. */
  actor: Author;
  role: 'admin' | 'owner';
  reason: string;
}

export interface RecoverySourceArchiveResult {
  sourceId: string;
  targetId: string;
  auditEventId: string;
  alreadyArchived: boolean;
}

function snapshotDigest(value: unknown): string {
  return computeContentHash(
    JSON.stringify(value, (_key: string, item: unknown): unknown => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        return Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
      }
      return item;
    }),
  );
}

export function memorySnapshotDigest(memory: CuratedMemory): string {
  return snapshotDigest(CuratedMemory.parse(memory));
}

export function auditEventSnapshotDigest(event: AuditEvent): string {
  return snapshotDigest(AuditEvent.parse(event));
}

function requireInput(input: RecoverySourceArchiveInput): void {
  Uuid.parse(input.runId);
  TenantId.parse(input.sourceTenantId);
  TenantId.parse(input.targetTenantId);
  Author.parse(input.actor);
  if (
    input.actor.type !== 'human' ||
    input.actor.id.trim() === '' ||
    (input.role !== 'admin' && input.role !== 'owner') ||
    typeof input.reason !== 'string' ||
    input.reason.trim() === '' ||
    input.sourceTenantId === input.targetTenantId ||
    input.source.id === input.target.id
  ) {
    throw new Error(
      'Recovery archival requires distinct tenants and declared human admin/owner authority and reason',
    );
  }
  for (const binding of [
    input.source,
    input.target,
    input.candidate,
    input.promotionReceipt,
    input.settlementReceipt,
  ]) {
    Uuid.parse(binding.id);
    Sha256Hash.parse(binding.snapshotDigest);
  }
}

function requireReceipt(
  binding: RecoverySnapshotBinding,
  memoryId: string,
  tenantId: string,
  audit: AuditRepository,
): AuditEvent {
  const event = audit
    .findByMemoryAndTenant(memoryId, tenantId)
    .find((item) => item.id === binding.id);
  if (event === undefined || auditEventSnapshotDigest(event) !== binding.snapshotDigest) {
    throw new Error('Recovery target receipt is missing or changed');
  }
  return event;
}

function selectedPromotion(value: unknown, candidateId: string, memoryId: string): boolean {
  return (
    Array.isArray(value) &&
    value.some((item: unknown) => {
      if (item === null || typeof item !== 'object') return false;
      const row = item as Record<string, unknown>;
      return (
        row['candidateId'] === candidateId &&
        row['outcome'] === 'promoted' &&
        row['memoryId'] === memoryId
      );
    })
  );
}

function sameRecoveredPayload(source: CuratedMemory, target: CuratedMemory): boolean {
  // Fresh intake stamps its own proposer role. Every other source metadata
  // field must survive; the complete reviewed target digest also binds it.
  const { proposedByRole: _sourceRole, ...sourceMetadata } = source.metadata;
  const { proposedByRole: _targetRole, ...targetMetadata } = target.metadata;
  const trust = { untrusted: 0, low: 1, medium: 2, high: 3 };
  const sensitivity = { public: 0, internal: 1, confidential: 2, restricted: 3 };
  return (
    source.content === target.content &&
    source.title === target.title &&
    source.category === target.category &&
    source.contentHash === computeContentHash(source.content) &&
    target.contentHash === source.contentHash &&
    trust[target.trustLevel] <= trust[source.trustLevel] &&
    sensitivity[target.sensitivity] >= sensitivity[source.sensitivity] &&
    isDeepStrictEqual(sourceMetadata, targetMetadata)
  );
}

function verifyTarget(
  input: RecoverySourceArchiveInput,
  memories: MemoryRepository,
  candidates: CandidateRepository,
  audit: AuditRepository,
): {
  target: CuratedMemory;
  candidate: MemoryCandidate;
  promotion: AuditEvent;
  settlement: AuditEvent;
} {
  const target = memories.findById(input.target.id);
  const candidate = candidates.findById(input.candidate.id);
  if (
    target === null ||
    candidate === null ||
    target.tenantId !== input.targetTenantId ||
    candidate.tenantId !== input.targetTenantId ||
    target.lifecycle !== 'active' ||
    candidate.status !== 'promoted' ||
    target.candidateId !== candidate.id ||
    memorySnapshotDigest(target) !== input.target.snapshotDigest ||
    candidateSnapshotDigest(candidate) !== input.candidate.snapshotDigest ||
    !isAudienceVisibleToRole(target.metadata.audience, input.role) ||
    target.content !== candidate.content ||
    target.contentHash !== computeContentHash(candidate.content) ||
    target.title !== candidate.title ||
    target.category !== candidate.category ||
    target.source !== candidate.source ||
    target.trustLevel !== candidate.trustLevel ||
    !isDeepStrictEqual(target.author, candidate.author) ||
    !isDeepStrictEqual(target.metadata, candidate.metadata)
  ) {
    throw new Error('Recovery target is not the current reviewed admitted candidate');
  }
  const promotion = requireReceipt(input.promotionReceipt, target.id, input.targetTenantId, audit);
  const settlement = requireReceipt(
    input.settlementReceipt,
    input.runId,
    input.targetTenantId,
    audit,
  );
  if (
    promotion.id !== deriveAuditEventId(target.id, 'promoted') ||
    promotion.action !== 'promoted' ||
    promotion.details['candidateId'] !== candidate.id ||
    promotion.timestamp !== target.promotedAt ||
    !isDeepStrictEqual(promotion.actor, target.promotedBy) ||
    settlement.action !== 'governed' ||
    settlement.details['kind'] !== 'selected-govern-v1' ||
    !selectedPromotion(settlement.details['outcomes'], candidate.id, target.id)
  ) {
    throw new Error('Recovery target lacks canonical promotion and selected-run evidence');
  }
  return { target, candidate, promotion, settlement };
}

/**
 * Archive one manifest-bound source only after checking its CURRENT admitted
 * target and pinned canonical receipts. All stores share this connection and
 * immediate transaction. Replays recheck target evidence and the archived source
 * digest, and write nothing. Caller establishes authority and takes the brain
 * filesystem lock; no capture, policy override, anchor or derived refresh here.
 */
export function archiveRecoveredSource(
  input: RecoverySourceArchiveInput,
  connection: Database.Database,
): RecoverySourceArchiveResult {
  requireInput(input);
  const manifestDigest = snapshotDigest(input);
  const memories = new MemoryRepository(connection);
  const candidates = new CandidateRepository(connection);
  const audit = new AuditRepository(connection);
  return connection
    .transaction(() => {
      const before = verifyTarget(input, memories, candidates, audit);
      const source = memories.findById(input.source.id);
      if (
        source === null ||
        source.tenantId !== input.sourceTenantId ||
        !isAudienceVisibleToRole(source.metadata.audience, input.role) ||
        !sameRecoveredPayload(source, before.target)
      ) {
        throw new Error('Recovery source is missing, outside authority or differs from its target');
      }
      const previous = audit
        .findByMemoryAndTenant(source.id, input.sourceTenantId)
        .find(
          (event) =>
            event.action === 'archived' &&
            event.details['kind'] === 'recovery-source-archive-v1' &&
            event.details['runId'] === input.runId,
        );
      if (previous !== undefined) {
        if (
          previous.details['manifestDigest'] !== manifestDigest ||
          source.lifecycle !== 'archived' ||
          previous.details['archivedSnapshotDigest'] !== memorySnapshotDigest(source)
        ) {
          throw new Error('Recovery archival replay has a different manifest or changed source');
        }
        return {
          sourceId: source.id,
          targetId: before.target.id,
          auditEventId: previous.id,
          alreadyArchived: true,
        };
      }
      if (
        source.lifecycle !== 'active' ||
        memorySnapshotDigest(source) !== input.source.snapshotDigest
      ) {
        throw new Error('Recovery source is no longer the reviewed active snapshot');
      }
      const at = new Date().toISOString();
      const archived = CuratedMemory.parse({ ...source, lifecycle: 'archived', updatedAt: at });
      const receipt = AuditEvent.parse({
        id: randomUUID(),
        action: 'archived',
        memoryId: source.id,
        tenantId: input.sourceTenantId,
        actor: input.actor,
        reason: input.reason,
        timestamp: at,
        details: {
          kind: 'recovery-source-archive-v1',
          runId: input.runId,
          manifestDigest,
          from: 'active',
          to: 'archived',
          targetId: before.target.id,
          targetTenantId: input.targetTenantId,
          targetCandidateId: before.candidate.id,
          promotionReceiptId: before.promotion.id,
          settlementReceiptId: before.settlement.id,
          archivedSnapshotDigest: memorySnapshotDigest(archived),
        },
      });
      if (!memories.updateLifecycle(source.id, 'archived', at))
        throw new Error('Recovery source archival was not persisted');
      audit.insert(receipt);
      const after = verifyTarget(input, memories, candidates, audit);
      if (
        !isDeepStrictEqual(before, after) ||
        !isDeepStrictEqual(memories.findById(source.id), archived) ||
        !isDeepStrictEqual(
          audit
            .findByMemoryAndTenant(source.id, input.sourceTenantId)
            .find((event) => event.id === receipt.id),
          receipt,
        )
      ) {
        throw new Error('Recovery archival state or receipt changed during settlement');
      }
      return {
        sourceId: source.id,
        targetId: before.target.id,
        auditEventId: receipt.id,
        alreadyArchived: false,
      };
    })
    .immediate();
}
