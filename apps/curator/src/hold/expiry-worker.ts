import { statSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { IsoDatetime, Sha256Hash, TenantId } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  openExistingDatabase,
} from '@qmd-team-intent-kb/store';
import { computeContentHash, deriveAuditEventId } from '@qmd-team-intent-kb/common';
import { acquireRecoveryWriteLock, requireRecoveryStore } from '../recovery/filesystem-boundary.js';
import { readPrivateRecoveryFile } from '../recovery/private-files.js';
import { beginHoldEscalation, completeHoldEscalation, planHoldEscalations } from './escalation.js';
import type { HoldEscalationPlan } from './escalation.js';
import { escalationOutcome } from './escalation-receipts.js';
import { findActiveHold } from './hold.js';
import {
  notificationRequestSchema,
  runNotificationTransport,
  verifyNotificationTransport,
} from './notification-transport.js';
import type { NotificationTransportResult } from './notification-transport.js';

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/);
const configSchema = z
  .object({
    version: z.literal(1),
    tenantId: TenantId,
    expiresAt: IsoDatetime,
    destinationId: identifier,
    reviewExecutable: z.string().min(1),
    operatorId: identifier,
    store: z
      .object({
        databasePath: z.string().min(1),
        basePath: z.string().min(1),
        baseDevice: z.number().int().nonnegative().safe(),
        baseInode: z.number().int().nonnegative().safe(),
        databaseDevice: z.number().int().nonnegative().safe(),
        databaseInode: z.number().int().nonnegative().safe(),
      })
      .strict(),
    transport: z
      .object({
        executable: z.string().min(1),
        sha256: Sha256Hash,
        timeoutMs: z.number().int().min(1).max(30000),
      })
      .strict(),
    lockTimeoutMs: z.number().int().min(0).max(30000).default(0),
  })
  .strict();
type WorkerConfig = z.infer<typeof configSchema>;

function readConfig(path: string): WorkerConfig {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error('Invalid config path');
  const directory = statSync(dirname(path));
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error('Config directory must be private');
  const config = configSchema.parse(JSON.parse(readPrivateRecoveryFile(path, 65536)));
  if (Date.parse(config.expiresAt) <= Date.now() || !isAbsolute(config.reviewExecutable))
    throw new Error('Config is expired or invalid');
  return config;
}
function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
function message(plan: HoldEscalationPlan, config: WorkerConfig, audience: string): string {
  const base = [config.reviewExecutable, 'holds'];
  const scope = ['--db', config.store.databasePath, '--tenant', config.tenantId];
  const args =
    plan.phase === 'final'
      ? [...base, 'list', ...scope, '--json']
      : [
          ...base,
          'resolve',
          ...scope,
          '--candidate-id',
          plan.candidateId,
          '--resolution',
          'release',
          '--audience',
          audience,
          '--actor',
          config.operatorId,
          '--reason',
          'Review held capture',
          '--dry-run',
        ];
  return [
    `Held capture ${plan.candidateId}; phase=${plan.phase}.`,
    `Deadline: ${plan.expiresAt}.`,
    `Remaining milliseconds at planning: ${plan.remainingMs}.`,
    plan.phase === 'final'
      ? 'The release window has closed. Inspect the retained proposal; this alert does not reopen it.'
      : 'Review required. This command previews a release; it does not approve or publish it.',
    args.map(quote).join(' '),
  ].join('\n');
}
export interface HoldExpiryWorkerResult {
  ok: boolean;
  action: 'preview' | 'idle' | 'attempted' | 'reconciliation_required' | 'refused';
  startedNew: boolean;
  outcomeRecorded: boolean;
  attemptId?: string;
  outcomeReceiptId?: string;
  transport?: NotificationTransportResult;
  plans?: HoldEscalationPlan[];
  reconciliationRequired: string[];
  error?: 'hold_expiry_worker_refused';
}

/** One independently invoked scan; at most one NEW external attempt per invocation. */
export async function runHoldExpiryWorker(
  configPath: string,
  apply = false,
): Promise<HoldExpiryWorkerResult> {
  const result: HoldExpiryWorkerResult = {
    ok: false,
    action: 'refused',
    startedNew: false,
    outcomeRecorded: false,
    reconciliationRequired: [],
  };
  let database: Database.Database | undefined;
  let lock: ReturnType<typeof acquireRecoveryWriteLock> | undefined;
  try {
    const config = readConfig(configPath);
    const transportBinding = computeContentHash(
      JSON.stringify({
        tenantId: config.tenantId,
        store: config.store,
        destinationId: config.destinationId,
        executable: config.transport.executable,
        sha256: config.transport.sha256,
        reviewExecutable: config.reviewExecutable,
        operatorId: config.operatorId,
      }),
    );
    if (apply) verifyNotificationTransport(config.transport);
    requireRecoveryStore(config.store);
    if (apply) lock = acquireRecoveryWriteLock(config.store, config.lockTimeoutMs);
    const assertBound = () => {
      requireRecoveryStore(config.store);
      lock?.verify();
      if (!isDeepStrictEqual(readConfig(configPath), config))
        throw new Error('Worker approval changed');
    };
    assertBound();
    database = openExistingDatabase({ path: config.store.databasePath, readonly: !apply });
    const repos = {
      candidateRepo: new CandidateRepository(database),
      memoryRepo: new MemoryRepository(database),
      auditRepo: new AuditRepository(database),
    };
    const plans = planHoldEscalations(config.tenantId, repos);
    if (!apply) {
      assertBound();
      result.plans = plans;
      result.action = 'preview';
      result.ok = true;
    } else {
      for (const plan of plans) {
        assertBound();
        const previous = repos.auditRepo
          .findByMemoryAndTenant(plan.candidateId, plan.tenantId)
          .find((event) => event.id === plan.attemptId);
        const previousBinding = previous
          ? Sha256Hash.optional().parse(previous.details['transportBinding'])
          : transportBinding;
        const hold = findActiveHold(plan.candidateId, plan.tenantId, repos)!;
        if (!['tenant', 'admins', 'owner'].includes(hold.recommendedAudience))
          throw new Error('Invalid review audience');
        // Reject unusable payloads before committing an intent that cannot be sent.
        const request = notificationRequestSchema.parse({
          version: 1,
          attemptId: plan.attemptId,
          destinationId: config.destinationId,
          message: message(plan, config, hold.recommendedAudience),
        });
        const start = beginHoldEscalation(plan, repos, new Date().toISOString(), previousBinding);
        if (start.alreadyStarted && previousBinding !== transportBinding) {
          result.reconciliationRequired.push(plan.attemptId);
          continue;
        }
        if (start.alreadyStarted) {
          const prior = repos.auditRepo
            .findByMemoryAndTenant(plan.candidateId, plan.tenantId)
            .find(
              (event) =>
                event.id === deriveAuditEventId(plan.attemptId, 'hold_escalated', 'outcome'),
            );
          if (!prior) result.reconciliationRequired.push(plan.attemptId);
          else {
            const outcome = escalationOutcome.parse(prior.details['outcome']);
            completeHoldEscalation(
              {
                candidateId: plan.candidateId,
                tenantId: plan.tenantId,
                attemptId: plan.attemptId,
                snapshotDigest: plan.snapshotDigest,
                outcome,
                transportBinding,
                ...(typeof prior.details['transportReceiptDigest'] === 'string'
                  ? { transportReceiptDigest: prior.details['transportReceiptDigest'] }
                  : {}),
              },
              repos,
            );
            if (outcome !== 'delivered') result.reconciliationRequired.push(plan.attemptId);
          }
          continue;
        }
        result.startedNew = true;
        result.attemptId = plan.attemptId;
        assertBound();
        result.transport = await runNotificationTransport(request, config.transport);
        // Configuration failure means no transport was started. Preserve intent,
        // require reconciliation, and do not satisfy final expiry with a fake attempt.
        if (result.transport.reason === 'invalid_configuration')
          throw new Error('Transport not started');
        requireRecoveryStore(config.store);
        lock!.verify();
        result.outcomeReceiptId = completeHoldEscalation(
          {
            candidateId: plan.candidateId,
            tenantId: plan.tenantId,
            attemptId: plan.attemptId,
            snapshotDigest: plan.snapshotDigest,
            outcome: result.transport.outcome,
            transportBinding,
            ...(result.transport.receiptDigest === undefined
              ? {}
              : { transportReceiptDigest: result.transport.receiptDigest }),
          },
          repos,
        );
        result.outcomeRecorded = true;
        if (result.transport.outcome !== 'delivered')
          result.reconciliationRequired.push(plan.attemptId);
        result.action = 'attempted';
        result.ok = true;
        break;
      }
      if (!result.startedNew) {
        result.action = result.reconciliationRequired.length ? 'reconciliation_required' : 'idle';
        result.ok = true;
      }
    }
  } catch {
    result.ok = false;
    result.action = 'refused';
    result.error = 'hold_expiry_worker_refused';
    if (result.startedNew && !result.outcomeRecorded && result.attemptId)
      result.reconciliationRequired.push(result.attemptId);
  } finally {
    try {
      database?.close();
    } catch {
      result.ok = false;
      result.error = 'hold_expiry_worker_refused';
    }
    try {
      lock?.release();
    } catch {
      result.ok = false;
      result.error = 'hold_expiry_worker_refused';
    }
  }
  return result;
}
