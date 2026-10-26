import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { openExistingDatabase } from '@qmd-team-intent-kb/store';
import { readRecoveryEnvelope } from './command.js';
import { acquireRecoveryWriteLock } from './filesystem-boundary.js';
import type { RecoveryStoreWitness } from './filesystem-boundary.js';
import { readPrivateRecoveryFile } from './private-files.js';
import { applyRecoveryPlan, readRecoveryStatus } from './recovery-application.js';
import type { RecoveryStatus } from './recovery-application.js';

export interface RecoveryExecutionRequest {
  operation: 'apply' | 'repair';
  planPath: string;
  expectedDigest: string;
  /** Explicit private key only for apply. Repair never reads a key or governs. */
  originSecretFile?: string;
  lockTimeoutMs?: number;
}

/** Trusted programmatic composition, never a user-configured shell hook. */
export interface RecoveryPostcommitContext {
  database: Database.Database;
  store: Readonly<RecoveryStoreWitness>;
  runId: string;
  planDigest: string;
  sourceTenantId: string;
  targetTenantId: string;
  /** Snapshot at settlement; a copy, not mutable validation authority. */
  status: RecoveryStatus;
  warnings: readonly string[];
  /** Fixed integration calls this between external stages to stop on drift. */
  assertStillBound(): void;
}

export type TrustedRecoveryPostcommit<T> = (context: RecoveryPostcommitContext) => Promise<T>;

type Operation = RecoveryExecutionRequest['operation'];
type Stage = 'preflight' | 'database' | 'postcommit' | 'finalization';
interface Observation {
  operation: Operation | 'unknown';
  committed: boolean | 'unknown';
  appliedNow: boolean | 'unknown';
  stage: Stage;
  postStarted: boolean;
  warnings: string[];
}

export type RecoveryExecutionResult<T> =
  | {
      ok: true;
      operation: Operation;
      /** A verified durable settlement, including a previous apply. */
      committed: true;
      appliedNow: boolean;
      status: RecoveryStatus;
      postcommit: { state: 'completed'; value: T } | { state: 'skipped_replay' };
      /** A generic callback cannot establish concrete recovery completion. */
      recoveryComplete: false;
      warnings: string[];
    }
  | {
      ok: false;
      operation: Operation | 'unknown';
      committed: boolean | 'unknown';
      appliedNow: boolean | 'unknown';
      failedStage: Stage;
      postcommit: { state: 'failed' | 'not_run' };
      error: 'recovery_refused';
      recoveryComplete: false;
      warnings: string[];
    };

function failure<T>(observed: Observation): RecoveryExecutionResult<T> {
  return {
    ok: false,
    operation: observed.operation,
    committed: observed.committed,
    appliedNow: observed.appliedNow,
    failedStage: observed.stage,
    postcommit: { state: observed.postStarted ? 'failed' : 'not_run' },
    error: 'recovery_refused',
    recoveryComplete: false,
    warnings: [...observed.warnings],
  };
}

function readApplySecret(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const secret = readPrivateRecoveryFile(path, 4096).trim();
  if (secret === '') throw new Error('Empty recovery key');
  return secret;
}

/**
 * Own the reviewed physical store, connection and actual kernel flock through
 * an awaited fixed integration. Fresh partial applies also need postprocessing.
 * Apply replay skips it; repair requires existing non-drifted settlement and
 * never invokes intake/govern/archive. No implicit key, store or shell lookup.
 *
 * Do not race a timeout against the callback and then unlock: its writers must
 * have terminated before it resolves or rejects. The fixed stage owns bounded
 * child termination. Callback completion is not anchor/export/index proof.
 */
export async function executeRecoveryEnvelope<T>(
  request: RecoveryExecutionRequest,
  postcommit: TrustedRecoveryPostcommit<T>,
): Promise<RecoveryExecutionResult<T>> {
  const observed: Observation = {
    operation: 'unknown',
    committed: false,
    appliedNow: false,
    stage: 'preflight',
    postStarted: false,
    warnings: [],
  };
  let lock: ReturnType<typeof acquireRecoveryWriteLock> | undefined;
  let database: Database.Database | undefined;
  const execute = async (): Promise<RecoveryExecutionResult<T>> => {
    const operation = request?.operation;
    if (operation !== 'apply' && operation !== 'repair')
      throw new Error('Unknown recovery operation');
    observed.operation = operation;
    if (
      typeof postcommit !== 'function' ||
      (operation === 'repair' && request.originSecretFile !== undefined)
    )
      throw new Error('Invalid recovery composition');
    const envelope = readRecoveryEnvelope(request.planPath, request.expectedDigest);
    const secret = operation === 'apply' ? readApplySecret(request.originSecretFile) : undefined;
    lock = acquireRecoveryWriteLock(envelope.store, request.lockTimeoutMs ?? 8000);
    lock.verify();
    database = openExistingDatabase({ path: envelope.store.databasePath, readonly: false });
    lock.verify();
    observed.stage = 'database';
    let status: RecoveryStatus;
    let replay = false;
    if (operation === 'apply') {
      observed.committed = 'unknown';
      observed.appliedNow = 'unknown';
      const result = applyRecoveryPlan(envelope.plan, envelope.plan.digest, database, {
        ...(secret === undefined ? {} : { originSecret: secret }),
        onDormantPolicy: () => {
          if (!observed.warnings.includes('dormant_policy_rules'))
            observed.warnings.push('dormant_policy_rules');
        },
      });
      status = result.status;
      replay = result.alreadyApplied;
      observed.appliedNow = !replay;
    } else {
      status = readRecoveryStatus(envelope.plan, envelope.plan.digest, database);
      if (status.state === 'drifted') observed.committed = 'unknown';
      if (
        status.state === 'not_applied' ||
        status.state === 'drifted' ||
        status.auditEventId === undefined
      )
        throw new Error('Repair requires verified existing settlement');
      observed.appliedNow = false;
    }
    observed.committed = true;
    const assertStillBound = (): void => {
      lock!.verify();
      const current = readRecoveryStatus(envelope.plan, envelope.plan.digest, database!);
      if (!isDeepStrictEqual(current, status)) throw new Error('Recovery settlement changed');
    };
    assertStillBound();
    let stageResult: { state: 'completed'; value: T } | { state: 'skipped_replay' };
    if (replay) stageResult = { state: 'skipped_replay' };
    else {
      observed.stage = 'postcommit';
      observed.postStarted = true;
      const value = await postcommit({
        database,
        store: Object.freeze({ ...envelope.store }),
        runId: envelope.plan.runId,
        planDigest: envelope.plan.digest,
        sourceTenantId: envelope.plan.sourceTenantId,
        targetTenantId: envelope.plan.targetTenantId,
        status: structuredClone(status),
        warnings: [...observed.warnings],
        assertStillBound,
      });
      assertStillBound();
      stageResult = { state: 'completed', value };
    }
    return {
      ok: true,
      operation: operation,
      committed: true,
      appliedNow: !replay && operation === 'apply',
      status,
      postcommit: stageResult,
      recoveryComplete: false,
      warnings: [...observed.warnings],
    };
  };
  let result: RecoveryExecutionResult<T>;
  try {
    result = await execute();
  } catch {
    result = failure(observed);
  }
  // Finalization also retains known settlement, and never leaves the lock held
  // merely because connection close failed. No raw error text is returned.
  try {
    database?.close();
  } catch {
    observed.stage = 'finalization';
    result = failure(observed);
  }
  try {
    lock?.release();
  } catch {
    observed.stage = 'finalization';
    result = failure(observed);
  }
  return result;
}
