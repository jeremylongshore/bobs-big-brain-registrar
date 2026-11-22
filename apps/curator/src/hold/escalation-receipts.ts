import { isDeepStrictEqual } from 'node:util';
import { computeContentHash, deriveAuditEventId } from '@qmd-team-intent-kb/common';
import { AuditEvent, IsoDatetime } from '@qmd-team-intent-kb/schema';
import { z } from 'zod';
import type { ActiveHold, HoldRepos } from './hold.js';

export const escalationOutcome = z.enum(['delivered', 'failed', 'unknown']);
export type EscalationOutcome = z.infer<typeof escalationOutcome>;
export type EscalationPhase = 'warning' | 'final';
const KIND = 'hold-expiry-escalation-v1';

export function requireHoldConnection(repos: HoldRepos): void {
  if (
    repos.candidateRepo.connection !== repos.memoryRepo.connection ||
    repos.auditRepo.connection !== repos.memoryRepo.connection
  )
    throw new Error('Hold repositories must share one connection');
}

export function storedHoldCandidate(hold: ActiveHold, repos: HoldRepos): Record<string, unknown> {
  requireHoldConnection(repos);
  const row = repos.memoryRepo.connection
    .prepare('SELECT * FROM candidates WHERE id = ? AND tenant_id = ?')
    .get(hold.candidateId, hold.tenantId) as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error('Missing held candidate');
  return row;
}

/** Exact stored row plus governing receipts; escalation receipts do not change the binding. */
export function holdEscalationDigest(hold: ActiveHold, repos: HoldRepos): string {
  const row = storedHoldCandidate(hold, repos);
  const events = repos.auditRepo
    .findByMemoryAndTenant(hold.candidateId, hold.tenantId)
    .filter((event) => ['held', 'hold_recommended', 'hold_resolved'].includes(event.action));
  return computeContentHash(JSON.stringify({ row, events }));
}

export function escalationId(hold: ActiveHold, digest: string, phase: EscalationPhase): string {
  return deriveAuditEventId(hold.candidateId, 'hold_escalated', `${phase}:${digest}`);
}

export function isEscalationStart(
  event: AuditEvent,
  hold: ActiveHold,
  digest: string,
  phase: EscalationPhase,
): boolean {
  return isDeepStrictEqual(
    event,
    escalationEvent(hold, escalationId(hold, digest, phase), event.timestamp, {
      phase,
      state: 'started',
      snapshotDigest: digest,
    }),
  );
}

export function isEscalationResult(
  event: AuditEvent,
  hold: ActiveHold,
  attemptId: string,
  digest: string,
): boolean {
  const parsed = escalationOutcome.safeParse(event.details['outcome']);
  return (
    parsed.success &&
    isDeepStrictEqual(
      event,
      escalationEvent(
        hold,
        deriveAuditEventId(attemptId, 'hold_escalated', 'outcome'),
        event.timestamp,
        { attemptId, snapshotDigest: digest, outcome: parsed.data },
      ),
    )
  );
}

/** Only a completed final attempt bound to the current row/recommendations satisfies expiry. */
export function finalEscalationReceipt(
  hold: ActiveHold,
  repos: HoldRepos,
  now: string,
): string | null {
  IsoDatetime.parse(now);
  const digest = holdEscalationDigest(hold, repos);
  const attemptId = escalationId(hold, digest, 'final');
  const events = repos.auditRepo.findByMemoryAndTenant(hold.candidateId, hold.tenantId);
  const start = events.find((event) => event.id === attemptId);
  const result = events.find(
    (event) => event.id === deriveAuditEventId(attemptId, 'hold_escalated', 'outcome'),
  );
  if (
    !start ||
    !result ||
    !isEscalationStart(start, hold, digest, 'final') ||
    !isEscalationResult(result, hold, attemptId, digest) ||
    Date.parse(start.timestamp) < Date.parse(hold.expiresAt) ||
    Date.parse(result.timestamp) < Date.parse(start.timestamp) ||
    Date.parse(result.timestamp) > Date.parse(now)
  )
    return null;
  return result.id;
}

export function escalationEvent(
  hold: ActiveHold,
  id: string,
  now: string,
  details: Record<string, unknown>,
): AuditEvent {
  return AuditEvent.parse({
    id,
    action: 'hold_escalated',
    memoryId: hold.candidateId,
    tenantId: hold.tenantId,
    actor: { type: 'system', id: 'hold-escalation' },
    reason: 'Hold expiry escalation transport record',
    timestamp: now,
    details: { kind: KIND, holdEventId: hold.holdEventId, ...details },
  });
}

/** Detect ignored/altered receipts and row-changing triggers before committing intent/outcome. */
export function persistEscalationEvent(
  event: AuditEvent,
  hold: ActiveHold,
  repos: HoldRepos,
): void {
  repos.auditRepo.insert(event);
  const stored = repos.auditRepo
    .findByMemoryAndTenant(hold.candidateId, hold.tenantId)
    .find((item) => item.id === event.id);
  if (
    !isDeepStrictEqual(stored, event) ||
    holdEscalationDigest(hold, repos) !== event.details['snapshotDigest']
  )
    throw new Error('Escalation receipt or candidate changed');
}
