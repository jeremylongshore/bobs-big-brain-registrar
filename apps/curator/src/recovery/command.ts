import { isDeepStrictEqual } from 'node:util';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { openExistingDatabase } from '@qmd-team-intent-kb/store';
import { applyRecoveryPlan, readRecoveryStatus } from './recovery-application.js';
import { planMemoryRecovery, validateRecoveryPlan } from './recovery-plan.js';
import type { RecoveryPlan, RecoveryPlanInput } from './recovery-plan.js';
import {
  acquireRecoveryWriteLock,
  inspectRecoveryStore,
  requireRecoveryStore,
} from './filesystem-boundary.js';
import type { RecoveryStoreWitness } from './filesystem-boundary.js';
import { readPrivateRecoveryFile, writePrivateRecoveryFile } from './private-files.js';

interface RecoveryEnvelope {
  schemaVersion: 1;
  plan: RecoveryPlan;
  store: RecoveryStoreWitness;
  digest: string;
}

export interface RecoveryCommandIO {
  output(value: unknown): void;
}

function digest(value: unknown): string {
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

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  )
    throw new Error('Invalid recovery envelope');
  return value as Record<string, unknown>;
}

export function readRecoveryEnvelope(path: string, expectedDigest: string): RecoveryEnvelope {
  const raw = object(JSON.parse(readPrivateRecoveryFile(path)) as unknown, [
    'schemaVersion',
    'plan',
    'store',
    'digest',
  ]);
  const { digest: supplied, ...payload } = raw;
  if (
    !/^[a-f0-9]{64}$/.test(expectedDigest) ||
    supplied !== expectedDigest ||
    digest(payload) !== expectedDigest ||
    raw['schemaVersion'] !== 1
  ) {
    throw new Error('Recovery envelope differs from reviewed digest');
  }
  const planValue = raw['plan'] as { digest?: unknown } | undefined;
  if (typeof planValue?.digest !== 'string') throw new Error('Invalid inner recovery plan');
  const plan = validateRecoveryPlan(planValue, planValue.digest);
  const store = object(raw['store'], [
    'databasePath',
    'basePath',
    'baseDevice',
    'baseInode',
    'databaseDevice',
    'databaseInode',
  ]);
  if (
    store['databasePath'] !== plan.storeLocator ||
    typeof store['basePath'] !== 'string' ||
    ['baseDevice', 'baseInode', 'databaseDevice', 'databaseInode'].some(
      (key) => !Number.isSafeInteger(store[key]) || Number(store[key]) < 0,
    )
  ) {
    throw new Error('Invalid recovery physical-store binding');
  }
  return {
    schemaVersion: 1,
    plan,
    store: store as unknown as RecoveryStoreWitness,
    digest: expectedDigest,
  };
}

function options(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      key === undefined ||
      !key.startsWith('--') ||
      value === undefined ||
      value.startsWith('--') ||
      values.has(key)
    ) {
      throw new Error('Recovery options require unique named values');
    }
    values.set(key, value);
  }
  return values;
}

function requireOption(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === '') throw new Error('Missing recovery option');
  return value;
}

function allowedOptions(values: Map<string, string>, allowed: readonly string[]): void {
  if ([...values.keys()].some((key) => !allowed.includes(key)))
    throw new Error('Unknown recovery option');
}

function originSecret(values: Map<string, string>): string | undefined {
  const path = values.get('--origin-secret-file');
  if (path === undefined) return undefined;
  const secret = readPrivateRecoveryFile(path, 4096).trim();
  if (secret === '') throw new Error('Empty private recovery origin key');
  return secret;
}

function planCommand(values: Map<string, string>): unknown {
  allowedOptions(values, ['--request', '--out', '--origin-secret-file', '--origin-channel']);
  const request = JSON.parse(
    readPrivateRecoveryFile(requireOption(values, '--request'), 1024 * 1024),
  ) as RecoveryPlanInput;
  const store = inspectRecoveryStore(request.storeLocator);
  const secret = originSecret(values);
  const channel = values.get('--origin-channel');
  if ((secret === undefined) !== (channel === undefined))
    throw new Error('Explicit origin key and claimed channel must be supplied together');
  const db = openExistingDatabase({ path: store.databasePath, readonly: true });
  try {
    requireRecoveryStore(store);
    const plan = planMemoryRecovery(
      request,
      db,
      secret === undefined ? {} : { origin: { secret, channel: channel! } },
    );
    requireRecoveryStore(store);
    const payload = { schemaVersion: 1 as const, plan, store };
    const envelope: RecoveryEnvelope = { ...payload, digest: digest(payload) };
    writePrivateRecoveryFile(requireOption(values, '--out'), envelope);
    return {
      ok: true,
      command: 'plan',
      reviewedDigest: envelope.digest,
      planDigest: plan.digest,
      selections: plan.entries.length,
      exclusions: plan.exclusions.length,
      originMode: plan.originMode,
    };
  } finally {
    db.close();
  }
}

function statusCommand(values: Map<string, string>): unknown {
  allowedOptions(values, ['--plan', '--digest']);
  const envelope = readRecoveryEnvelope(
    requireOption(values, '--plan'),
    requireOption(values, '--digest'),
  );
  requireRecoveryStore(envelope.store);
  const db = openExistingDatabase({ path: envelope.store.databasePath, readonly: true });
  try {
    requireRecoveryStore(envelope.store);
    const status = readRecoveryStatus(envelope.plan, envelope.plan.digest, db);
    requireRecoveryStore(envelope.store);
    return {
      ok: true,
      command: 'status',
      status,
      recoveryComplete: false,
      postcommit: { anchor: 'not_verified', exports: 'not_verified', index: 'not_verified' },
    };
  } finally {
    db.close();
  }
}

interface CommitObservation {
  value: boolean | 'unknown';
}

function applyCommand(values: Map<string, string>, observation: CommitObservation): unknown {
  allowedOptions(values, ['--plan', '--digest', '--origin-secret-file', '--lock-timeout-ms']);
  const envelope = readRecoveryEnvelope(
    requireOption(values, '--plan'),
    requireOption(values, '--digest'),
  );
  const secret = originSecret(values);
  const timeout = values.has('--lock-timeout-ms') ? Number(values.get('--lock-timeout-ms')) : 8000;
  const lock = acquireRecoveryWriteLock(envelope.store, timeout);
  try {
    lock.verify();
    const db = openExistingDatabase({ path: envelope.store.databasePath, readonly: false });
    try {
      requireRecoveryStore(envelope.store);
      lock.verify();
      observation.value = 'unknown';
      const warnings = new Set<string>();
      const result = applyRecoveryPlan(envelope.plan, envelope.plan.digest, db, {
        ...(secret === undefined ? {} : { originSecret: secret }),
        onDormantPolicy: () => {
          warnings.add('dormant_policy_rules');
        },
      });
      observation.value = !result.alreadyApplied;
      lock.verify();
      return {
        ok: true,
        command: 'apply',
        committed: observation.value,
        alreadyApplied: result.alreadyApplied,
        warnings: [...warnings],
        status: result.status,
        recoveryComplete: false,
        postcommit: { anchor: 'pending', exports: 'pending', index: 'pending' },
      };
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}

/** Operational maintenance surface. No implicit store/key lookup or postcommit success. */
export function runRecoveryCommand(args: readonly string[], io: RecoveryCommandIO): number {
  const observation: CommitObservation = { value: false };
  try {
    if (args.length === 0 || args[0] === '--help') {
      io.output({
        commands: [
          'plan --request PRIVATE_JSON --out PRIVATE_PLAN [--origin-secret-file PRIVATE_KEY --origin-channel CLAIM]',
          'status --plan PRIVATE_PLAN --digest REVIEWED_DIGEST',
          'apply --plan PRIVATE_PLAN --digest REVIEWED_DIGEST [--origin-secret-file PRIVATE_KEY] [--lock-timeout-ms 8000]',
        ],
        requirements:
          'Existing current-schema owner-private store; private owner files. Apply uses the brain .write.lock. Postcommit integration remains pending.',
      });
      return 0;
    }
    const values = options(args.slice(1));
    let result: unknown;
    if (args[0] === 'plan') result = planCommand(values);
    else if (args[0] === 'status') result = statusCommand(values);
    else if (args[0] === 'apply') result = applyCommand(values, observation);
    else throw new Error('Unknown recovery command');
    io.output(result);
    return 0;
  } catch {
    // Never echo source text, private HMAC/key material or raw schema errors.
    // Once application starts, a thrown operation is conservatively unknown;
    // status plus the SQLite receipt establishes settlement independently.
    io.output({
      ok: false,
      command: ['plan', 'status', 'apply'].includes(args[0] ?? '') ? args[0] : 'unknown',
      committed: observation.value,
      error: 'recovery_refused',
      recoveryComplete: false,
    });
    return 1;
  }
}
