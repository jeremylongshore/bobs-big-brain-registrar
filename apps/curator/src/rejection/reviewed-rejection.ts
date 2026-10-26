import { randomUUID } from 'node:crypto';

import { isAudienceVisibleToRole } from '@qmd-team-intent-kb/common';
import { AuditEvent as AuditEventSchema } from '@qmd-team-intent-kb/schema';
import type { Author } from '@qmd-team-intent-kb/schema';
import { AuditRepository, CandidateRepository, MemoryRepository } from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';

import { findActiveHold } from '../hold/hold.js';

export interface ReviewedRejectionInput {
  candidateId: string;
  tenantId: string;
  /** Caller-declared identity, not proof that a physical person issued the call. */
  actor: Author;
  /** Only admin/owner accepted; caller establishes identity, standing and tenant binding. */
  role: string;
  /** Recorded through the canonical audit schema; never supply credentials or private content. */
  reason: string;
}

export type ReviewedRejectionRefusalCode =
  | 'missing_reason'
  | 'missing_actor'
  | 'not_human'
  | 'forbidden_role'
  | 'not_found'
  | 'on_hold'
  | 'not_pending'
  | 'audience_above_standing';

export type ReviewedRejectionResult =
  | { ok: true; candidateId: string; auditEventId: string }
  | { ok: false; candidateId: string; code: ReviewedRejectionRefusalCode };

/**
 * Retire one person-reviewed inbox candidate without changing its content or
 * creating a memory. All repositories are constructed on the supplied connection;
 * the locked re-read, status and canonical hash-chained receipt form one transaction.
 * A repeat with unchanged authority returns `not_pending` and writes nothing.
 * `not_pending` also covers linked memories; holds use `resolveHold` instead.
 * Expected refusals return codes; storage/schema failures throw and roll back.
 * This function does not append an external anchor or reconcile derived exports.
 */
export function rejectReviewedCandidate(
  input: ReviewedRejectionInput,
  connection: Database.Database,
): ReviewedRejectionResult {
  const { candidateId } = input;
  const refuse = (code: ReviewedRejectionRefusalCode): ReviewedRejectionResult => ({
    ok: false,
    candidateId,
    code,
  });
  if (typeof input.reason !== 'string' || input.reason.trim() === '')
    return refuse('missing_reason');
  if (input.actor === undefined || input.actor === null) return refuse('missing_actor');
  if (input.actor.type !== 'human') return refuse('not_human');
  if (typeof input.actor.id !== 'string' || input.actor.id.trim() === '')
    return refuse('missing_actor');
  if (input.role !== 'owner' && input.role !== 'admin') return refuse('forbidden_role');

  const candidateRepo = new CandidateRepository(connection);
  const memoryRepo = new MemoryRepository(connection);
  const auditRepo = new AuditRepository(connection);
  return connection
    .transaction((): ReviewedRejectionResult => {
      const candidate = candidateRepo.findById(candidateId);
      if (candidate === null || candidate.tenantId !== input.tenantId) return refuse('not_found');
      if (!isAudienceVisibleToRole(candidate.metadata.audience, input.role)) {
        return refuse('audience_above_standing');
      }
      if (findActiveHold(candidateId, input.tenantId, { candidateRepo, memoryRepo, auditRepo })) {
        return refuse('on_hold');
      }
      if (candidate.status !== 'inbox') return refuse('not_pending');
      if (memoryRepo.existsForCandidate(candidateId, input.tenantId)) return refuse('not_pending');

      const auditEventId = randomUUID();
      const receipt = AuditEventSchema.parse({
        id: auditEventId,
        action: 'deleted',
        memoryId: candidateId,
        tenantId: input.tenantId,
        actor: input.actor,
        reason: input.reason,
        details: { candidateId, disposition: 'rejected', resolverRole: input.role },
        timestamp: new Date().toISOString(),
      });
      if (candidateRepo.updateStatus(candidateId, 'rejected', input.tenantId) !== 1) {
        throw new Error('Reviewed rejection status was not persisted');
      }
      auditRepo.insert(receipt);
      const persisted = auditRepo.findByMemoryAndTenant(candidateId, input.tenantId);
      if (!persisted.some((event) => event.id === auditEventId)) {
        throw new Error('Reviewed rejection receipt was not persisted');
      }
      return { ok: true, candidateId, auditEventId };
    })
    .immediate();
}
