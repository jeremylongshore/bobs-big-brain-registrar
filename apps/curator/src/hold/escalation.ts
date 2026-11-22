import { deriveAuditEventId } from '@qmd-team-intent-kb/common';
import { IsoDatetime, Sha256Hash, Uuid } from '@qmd-team-intent-kb/schema';
import { z } from 'zod';
import { findActiveHold, listActiveHolds } from './hold.js';
import type { HoldRepos } from './hold.js';
import {
  escalationEvent,
  persistEscalationEvent,
  isEscalationStart,
  isEscalationResult,
  escalationId,
  escalationOutcome,
  holdEscalationDigest,
  requireHoldConnection,
} from './escalation-receipts.js';
import type { EscalationOutcome, EscalationPhase } from './escalation-receipts.js';

const DAY_MS = 86_400_000;
export interface HoldEscalationPlan {
  candidateId: string;
  tenantId: string;
  phase: EscalationPhase;
  expiresAt: string;
  remainingMs: number;
  snapshotDigest: string;
  attemptId: string;
}

/** Read-only metadata, never held titles, content or recommendation reasoning. */
export function planHoldEscalations(
  tenantId: string,
  repos: HoldRepos,
  now = new Date().toISOString(),
): HoldEscalationPlan[] {
  IsoDatetime.parse(now);
  requireHoldConnection(repos);
  return listActiveHolds(tenantId, repos, now).flatMap((hold) => {
    IsoDatetime.parse(hold.expiresAt);
    const remainingMs = Date.parse(hold.expiresAt) - Date.parse(now);
    if (remainingMs > DAY_MS) return [];
    const phase = remainingMs <= 0 ? 'final' : 'warning';
    const snapshotDigest = holdEscalationDigest(hold, repos);
    return [
      {
        candidateId: hold.candidateId,
        tenantId,
        phase,
        expiresAt: hold.expiresAt,
        remainingMs,
        snapshotDigest,
        attemptId: escalationId(hold, snapshotDigest, phase),
      },
    ];
  });
}

/** Trusted worker only: commit intent before external I/O, never send inside this transaction. */
export function beginHoldEscalation(
  plan: HoldEscalationPlan,
  repos: HoldRepos,
  now = new Date().toISOString(),
): { attemptId: string; alreadyStarted: boolean } {
  requireHoldConnection(repos);
  if (repos.memoryRepo.connection.inTransaction)
    throw new Error('Escalation requires its own transaction');
  return repos.memoryRepo.connection
    .transaction(() => {
      const current = planHoldEscalations(plan.tenantId, repos, now).find(
        (item) => item.candidateId === plan.candidateId,
      );
      if (
        !current ||
        current.attemptId !== plan.attemptId ||
        current.snapshotDigest !== plan.snapshotDigest ||
        current.phase !== plan.phase
      )
        throw new Error('Stale escalation plan');
      const existing = repos.auditRepo
        .findByMemoryAndTenant(plan.candidateId, plan.tenantId)
        .find((event) => event.id === plan.attemptId);
      const hold = findActiveHold(plan.candidateId, plan.tenantId, repos, now)!;
      if (existing) {
        if (
          !isEscalationStart(existing, hold, plan.snapshotDigest, plan.phase) ||
          Date.parse(existing.timestamp) > Date.parse(now)
        )
          throw new Error('Invalid escalation intent');
        return { attemptId: plan.attemptId, alreadyStarted: true };
      }
      persistEscalationEvent(
        escalationEvent(hold, plan.attemptId, now, {
          phase: plan.phase,
          state: 'started',
          snapshotDigest: plan.snapshotDigest,
        }),
        hold,
        repos,
      );
      return { attemptId: plan.attemptId, alreadyStarted: false };
    })
    .immediate();
}

const completion = z
  .object({
    candidateId: Uuid,
    tenantId: z.string().min(1),
    attemptId: Uuid,
    snapshotDigest: Sha256Hash,
    outcome: escalationOutcome,
  })
  .strict();
export interface HoldEscalationCompletion {
  candidateId: string;
  tenantId: string;
  attemptId: string;
  snapshotDigest: string;
  outcome: EscalationOutcome;
}

/** Transport assertions are not human acknowledgement; unknown is never reported delivered. */
export function completeHoldEscalation(
  value: HoldEscalationCompletion,
  repos: HoldRepos,
  now = new Date().toISOString(),
): string {
  const input = completion.parse(value);
  IsoDatetime.parse(now);
  requireHoldConnection(repos);
  if (repos.memoryRepo.connection.inTransaction)
    throw new Error('Escalation requires its own transaction');
  return repos.memoryRepo.connection
    .transaction(() => {
      const hold = findActiveHold(input.candidateId, input.tenantId, repos, now);
      if (!hold || holdEscalationDigest(hold, repos) !== input.snapshotDigest)
        throw new Error('Stale escalation result');
      const events = repos.auditRepo.findByMemoryAndTenant(input.candidateId, input.tenantId);
      const start = events.find((event) => event.id === input.attemptId);
      const phase = start?.details['phase'];
      if (
        !start ||
        (phase !== 'warning' && phase !== 'final') ||
        !isEscalationStart(start, hold, input.snapshotDigest, phase) ||
        Date.parse(now) < Date.parse(start.timestamp)
      )
        throw new Error('Escalation attempt missing');
      const id = deriveAuditEventId(input.attemptId, 'hold_escalated', 'outcome');
      const existing = events.find((event) => event.id === id);
      if (existing) {
        if (
          !isEscalationResult(existing, hold, input.attemptId, input.snapshotDigest) ||
          existing.details['outcome'] !== input.outcome ||
          Date.parse(existing.timestamp) > Date.parse(now)
        )
          throw new Error('Conflicting escalation outcome');
        return id;
      }
      persistEscalationEvent(
        escalationEvent(hold, id, now, {
          attemptId: input.attemptId,
          snapshotDigest: input.snapshotDigest,
          outcome: input.outcome,
        }),
        hold,
        repos,
      );
      return id;
    })
    .immediate();
}
