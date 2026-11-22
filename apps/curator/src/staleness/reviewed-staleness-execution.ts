import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { IsoDatetime, Sha256Hash } from '@qmd-team-intent-kb/schema';
import { openExistingDatabase } from '@qmd-team-intent-kb/store';
import { z } from 'zod';
import { acquireRecoveryWriteLock } from '../recovery/filesystem-boundary.js';
import { readPrivateRecoveryFile } from '../recovery/private-files.js';
import {
  parseReviewedStalenessManifest,
  reviewedStalenessDigest,
} from './reviewed-staleness-manifest.js';
import { settleReviewedStaleness } from './reviewed-staleness.js';
import type { ReviewedStalenessResult } from './reviewed-staleness.js';
import type { StalenessRule } from './staleness-rules.js';

const identifier = z.string().trim().min(1).max(256);
const physicalStore = z
  .object({
    databasePath: z.string().min(1),
    basePath: z.string().min(1),
    baseDevice: z.number().int().nonnegative().safe(),
    baseInode: z.number().int().nonnegative().safe(),
    databaseDevice: z.number().int().nonnegative().safe(),
    databaseInode: z.number().int().nonnegative().safe(),
  })
  .strict();
const approvalSchema = z
  .object({
    version: z.literal(1),
    manifestDigest: Sha256Hash,
    actorId: identifier,
    role: z.enum(['admin', 'owner']),
    tenantId: identifier,
    expiresAt: IsoDatetime,
    store: physicalStore,
    sources: z
      .array(z.object({ sha256: Sha256Hash, base64: z.string().max(1_400_000) }).strict())
      .max(100),
  })
  .strict();

/** Set by trusted deployment code, never taken from a request body. */
export interface ReviewedStalenessInstallation {
  approvalFile: string;
  databasePath: string;
  /** Trusted in-process rule composition; the production entry uses shipped rules. */
  rules?: readonly StalenessRule[];
  lockTimeoutMs?: number;
}

/** Derived from the existing bearer registry, never from claimed manifest identity. */
export interface ReviewedStalenessIdentity {
  authenticated: boolean;
  actor: string;
  role: 'member' | 'admin' | 'owner';
  agent: boolean;
  tenants?: readonly string[];
}

export interface ReviewedStalenessExecutionResult {
  ok: boolean;
  committed: boolean | 'unknown';
  appliedNow: boolean | 'unknown';
  failedStage?: 'authorization' | 'preflight' | 'settlement' | 'finalization';
  error?: 'reviewed_staleness_refused';
  settlement?: ReviewedStalenessResult;
  /** Database settlement does not establish downstream readiness. */
  postcommit: { anchors: 'not_verified'; exports: 'not_verified'; index: 'not_verified' };
}

function readApproval(path: string) {
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path)
    throw new Error('Invalid approval path');
  const directory = statSync(dirname(path));
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error('Approval directory must be owner-private');
  return approvalSchema.parse(JSON.parse(readPrivateRecoveryFile(path, 8 * 1024 * 1024)));
}

function capturedSources(
  sources: z.infer<typeof approvalSchema>['sources'],
): Map<string, Uint8Array> {
  const captured = new Map<string, Uint8Array>();
  for (const source of sources) {
    const bytes = Buffer.from(source.base64, 'base64');
    if (
      bytes.length > 1024 * 1024 ||
      bytes.toString('base64') !== source.base64 ||
      createHash('sha256').update(bytes).digest('hex') !== source.sha256 ||
      captured.has(source.sha256)
    )
      throw new Error('Invalid captured rule source');
    captured.set(source.sha256, bytes);
  }
  return captured;
}

/**
 * Synchronous database-only caller. The private approval file is trusted operator
 * configuration, not proof against another process with the same OS credentials.
 * It is reread after lock acquisition so withdrawal/replacement while waiting
 * refuses. No network fetches, schema migration, live defaults or approval writes.
 */
export function executeReviewedStaleness(
  value: unknown,
  authorize: () => ReviewedStalenessIdentity,
  installation: ReviewedStalenessInstallation,
): ReviewedStalenessExecutionResult {
  let stage: NonNullable<ReviewedStalenessExecutionResult['failedStage']> = 'authorization';
  let committed: boolean | 'unknown' = false;
  let appliedNow: boolean | 'unknown' = false;
  let settlement: ReviewedStalenessResult | undefined;
  let database: Database.Database | undefined;
  let lock: ReturnType<typeof acquireRecoveryWriteLock> | undefined;
  let failed = false;
  try {
    const identity = authorize();
    if (
      !identity.authenticated ||
      identity.agent ||
      identity.role === 'member' ||
      !identity.actor.trim() ||
      ['dev', 'shared', 'teamkb-review-agent'].includes(identity.actor)
    )
      throw new Error('Named authenticated human reviewer required');
    const manifest = parseReviewedStalenessManifest(value);
    if (
      manifest.actor.id !== identity.actor ||
      manifest.role !== identity.role ||
      (identity.tenants?.length && !identity.tenants.includes(manifest.tenantId))
    )
      throw new Error('Reviewer authority mismatch');
    const approval = readApproval(installation.approvalFile);
    if (
      approval.actorId !== identity.actor ||
      approval.role !== identity.role ||
      approval.tenantId !== manifest.tenantId ||
      approval.manifestDigest !== reviewedStalenessDigest(manifest)
    )
      throw new Error('Independent approval mismatch');
    stage = 'preflight';
    if (
      approval.store.databasePath !== installation.databasePath ||
      Date.parse(approval.expiresAt) <= Date.now()
    )
      throw new Error('Approval unavailable for this store or time');
    const sources = capturedSources(approval.sources);
    lock = acquireRecoveryWriteLock(approval.store, installation.lockTimeoutMs ?? 8000);
    lock.verify();
    if (
      !isDeepStrictEqual(readApproval(installation.approvalFile), approval) ||
      Date.parse(approval.expiresAt) <= Date.now()
    )
      throw new Error('Approval changed while waiting');
    database = openExistingDatabase({ path: installation.databasePath, readonly: false });
    lock.verify();
    if (
      !isDeepStrictEqual(authorize(), identity) ||
      !isDeepStrictEqual(readApproval(installation.approvalFile), approval) ||
      Date.parse(approval.expiresAt) <= Date.now()
    ) {
      stage = 'authorization';
      throw new Error('Authority changed before settlement');
    }
    stage = 'settlement';
    committed = 'unknown';
    appliedNow = 'unknown';
    settlement = settleReviewedStaleness(manifest, approval.manifestDigest, database, {
      rules: installation.rules,
      sourceBytes: (source) => sources.get(source.sha256),
    });
    committed = true;
    appliedNow = !settlement.replay;
    stage = 'finalization';
    lock.verify();
  } catch {
    failed = true;
  }
  // Preserve known commit state and attempt both cleanup operations. Never turn
  // a post-commit close/unlock failure into an assertion that no write happened.
  try {
    database?.close();
  } catch {
    failed = true;
    stage = 'finalization';
  }
  try {
    lock?.release();
  } catch {
    failed = true;
    stage = 'finalization';
  }
  return {
    ok: !failed,
    committed,
    appliedNow,
    ...(failed ? { failedStage: stage, error: 'reviewed_staleness_refused' as const } : {}),
    ...(settlement === undefined ? {} : { settlement }),
    postcommit: { anchors: 'not_verified', exports: 'not_verified', index: 'not_verified' },
  };
}
