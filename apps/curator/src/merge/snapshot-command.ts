import { z } from 'zod';
import { AuditRepository, MemoryRepository, openExistingDatabase } from '@qmd-team-intent-kb/store';
import {
  acquireRecoveryWriteLock,
  inspectRecoveryStore,
  requireRecoveryStore,
} from '../recovery/filesystem-boundary.js';
import { writePrivateRecoveryFile } from '../recovery/private-files.js';
import { applySourceImport, previewSourceImport } from './source-import.js';
import type { SourceImportOutcome } from './source-import-schema.js';
import { MAX_IMPORT_SOURCES } from './source-import-schema.js';
import { exportSourceSnapshot } from './source-snapshot.js';
import {
  MAX_SOURCE_SNAPSHOT_BYTES,
  SignedSourceSnapshot,
  TrustedSourceCheckpoint,
  sourceSnapshotDigest,
} from './source-snapshot-schema.js';
import {
  SnapshotExportRequest,
  SnapshotPreviewRequest,
  canonicalInputPath,
  readSnapshotEnvelope,
  readSnapshotInput,
} from './snapshot-command-schema.js';

export interface SnapshotCommandIO {
  output(value: unknown): void;
}
type Options = Map<string, string>;
interface CommitObservation {
  value: boolean | 'unknown';
}
const postcommit = {
  anchor: 'not_verified',
  exports: 'not_verified',
  index: 'not_verified',
} as const;

function options(args: readonly string[], allowed: readonly string[]): Options {
  const values: Options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      key === undefined ||
      !allowed.includes(key) ||
      value === undefined ||
      value.startsWith('--') ||
      value.trim() === '' ||
      values.has(key)
    )
      throw new Error('Invalid snapshot options');
    values.set(key, value);
  }
  return values;
}
function required(values: Options, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new Error('Missing snapshot option');
  return value;
}
function counts(outcomes: readonly SourceImportOutcome[]) {
  const result = { promoted: 0, existing: 0, deduplicated: 0, rejected: 0 };
  for (const outcome of outcomes) result[outcome.status]++;
  return result;
}
function readArtifacts(paths: readonly string[]): string[] {
  let remaining = MAX_SOURCE_SNAPSHOT_BYTES;
  return paths.map((path) => {
    const text = readSnapshotInput(path, remaining);
    remaining -= Buffer.byteLength(text);
    return text;
  });
}
function readCheckpoints(path: string) {
  return z
    .array(TrustedSourceCheckpoint)
    .min(1)
    .max(MAX_IMPORT_SOURCES)
    .parse(JSON.parse(readSnapshotInput(path, 128 * 1024)));
}

function exportCommand(args: readonly string[]) {
  const values = options(args, ['--request', '--private-key-file', '--out']);
  const request = SnapshotExportRequest.parse(
    JSON.parse(readSnapshotInput(required(values, '--request'), 64 * 1024)),
  );
  const store = inspectRecoveryStore(request.storePath);
  const key = readSnapshotInput(required(values, '--private-key-file'), 4096).trim();
  const output = required(values, '--out');
  const db = openExistingDatabase({ path: store.databasePath, readonly: true });
  try {
    requireRecoveryStore(store);
    const snapshot = SignedSourceSnapshot.parse(
      JSON.parse(exportSourceSnapshot(db, request.options, key)),
    );
    requireRecoveryStore(store);
    writePrivateRecoveryFile(output, snapshot);
    return {
      ok: true,
      command: 'export',
      snapshotDigest: snapshot.digest,
      items: snapshot.payload.itemCount,
      sourceModified: false,
    };
  } finally {
    db.close();
  }
}

function previewCommand(args: readonly string[]) {
  const values = options(args, ['--request', '--checkpoints', '--out']);
  const request = SnapshotPreviewRequest.parse(
    JSON.parse(readSnapshotInput(required(values, '--request'), 256 * 1024)),
  );
  const store = inspectRecoveryStore(request.storePath);
  const checkpointPath = canonicalInputPath(required(values, '--checkpoints'));
  const output = required(values, '--out');
  const artifacts = readArtifacts(request.artifactPaths);
  const db = openExistingDatabase({ path: store.databasePath, readonly: true });
  try {
    const result = previewSourceImport(
      artifacts,
      { memoryRepo: new MemoryRepository(db), auditRepo: new AuditRepository(db) },
      {
        tenantId: request.tenantId,
        now: Date.now,
        loadCheckpoints: () => {
          requireRecoveryStore(store);
          return readCheckpoints(checkpointPath);
        },
      },
    );
    requireRecoveryStore(store);
    const payload = {
      kind: 'reviewed-source-import-v1' as const,
      store,
      artifactPaths: request.artifactPaths,
      checkpointPath,
      plan: result.plan,
      outcomes: result.outcomes,
    };
    const digest = sourceSnapshotDigest(payload);
    writePrivateRecoveryFile(output, { ...payload, digest });
    return {
      ok: true,
      command: 'preview',
      reviewedDigest: digest,
      importDigest: result.plan.importDigest,
      alreadyApplied: result.alreadyApplied,
      planned: counts(result.outcomes),
      committed: false,
    };
  } finally {
    db.close();
  }
}

function applyCommand(args: readonly string[], observation: CommitObservation) {
  const values = options(args, ['--plan', '--digest', '--checkpoints', '--lock-timeout-ms']);
  const envelope = readSnapshotEnvelope(required(values, '--plan'), required(values, '--digest'));
  const checkpointPath = canonicalInputPath(required(values, '--checkpoints'));
  if (checkpointPath !== envelope.checkpointPath) throw new Error('Checkpoint provider changed');
  const timeout = values.get('--lock-timeout-ms') ?? '8000';
  if (!/^\d+$/.test(timeout)) throw new Error('Invalid lock timeout');
  const lock = acquireRecoveryWriteLock(envelope.store, Number(timeout));
  try {
    const artifacts = readArtifacts(envelope.artifactPaths);
    const db = openExistingDatabase({ path: envelope.store.databasePath, readonly: false });
    try {
      lock.verify();
      observation.value = 'unknown';
      const result = applySourceImport(
        envelope.plan,
        artifacts,
        { memoryRepo: new MemoryRepository(db), auditRepo: new AuditRepository(db) },
        {
          tenantId: envelope.plan.tenantId,
          now: Date.now,
          loadCheckpoints: () => {
            lock.verify();
            return readCheckpoints(checkpointPath);
          },
        },
      );
      observation.value = !result.alreadyApplied;
      lock.verify();
      return {
        ok: true,
        command: 'apply',
        committed: observation.value,
        alreadyApplied: result.alreadyApplied,
        importDigest: result.importDigest,
        settlement: counts(result.outcomes),
        postcommit,
      };
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}

/** Explicit local operator interface; no enrollment, implicit stores or postcommit execution. */
export function runSnapshotCommand(args: readonly string[], io: SnapshotCommandIO): number {
  const observation: CommitObservation = { value: false };
  try {
    if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
      io.output({
        commands: [
          'export --request PRIVATE_JSON --private-key-file PRIVATE_KEY --out PRIVATE_SNAPSHOT',
          'preview --request PRIVATE_JSON --checkpoints TRUSTED_PRIVATE_JSON --out PRIVATE_PLAN',
          'apply --plan PRIVATE_PLAN --digest REVIEWED_DIGEST --checkpoints TRUSTED_PRIVATE_JSON [--lock-timeout-ms 8000]',
        ],
        requirements:
          'Existing current-schema owner-private stores and files. Checkpoints require independent operator authorization. Apply uses the brain write lock. Anchoring, exports and indexing are not performed.',
      });
      return 0;
    }
    let result: unknown;
    if (args[0] === 'export') result = exportCommand(args.slice(1));
    else if (args[0] === 'preview') result = previewCommand(args.slice(1));
    else if (args[0] === 'apply') result = applyCommand(args.slice(1), observation);
    else throw new Error('Unknown snapshot command');
    io.output(result);
    return 0;
  } catch {
    // Never echo private paths, source text, keys, raw schema errors or caller values.
    io.output({
      ok: false,
      command: ['export', 'preview', 'apply'].includes(args[0] ?? '') ? args[0] : 'unknown',
      error: 'snapshot_command_refused',
      committed: observation.value,
      postcommit,
    });
    return 1;
  }
}
