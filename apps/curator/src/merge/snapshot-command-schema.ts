import { realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { Sha256Hash } from '@qmd-team-intent-kb/schema';
import { readPrivateRecoveryFile } from '../recovery/private-files.js';
import {
  MAX_IMPORT_SOURCES,
  SourceImportOutcome,
  SourceImportPlan,
} from './source-import-schema.js';
import { SourceSnapshotOptions, sourceSnapshotDigest } from './source-snapshot-schema.js';

const path = z.string().min(1).max(4096);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const SnapshotStoreWitness = z
  .object({
    databasePath: path,
    basePath: path,
    baseDevice: integer,
    baseInode: integer,
    databaseDevice: integer,
    databaseInode: integer,
  })
  .strict();
export const SnapshotExportRequest = z
  .object({
    storePath: path,
    options: SourceSnapshotOptions,
  })
  .strict();
export const SnapshotPreviewRequest = z
  .object({
    storePath: path,
    tenantId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim() === value),
    artifactPaths: z.array(path).min(1).max(MAX_IMPORT_SOURCES),
  })
  .strict();
export const SnapshotImportEnvelope = z
  .object({
    kind: z.literal('reviewed-source-import-v1'),
    store: SnapshotStoreWitness,
    artifactPaths: z.array(path).min(1).max(MAX_IMPORT_SOURCES),
    checkpointPath: path,
    plan: SourceImportPlan,
    outcomes: z.array(SourceImportOutcome).max(10_000),
    digest: Sha256Hash,
  })
  .strict();
export type SnapshotImportEnvelope = z.infer<typeof SnapshotImportEnvelope>;

export function canonicalInputPath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || realpathSync(value) !== value)
    throw new Error('Snapshot input path must be canonical');
  return value;
}

export function readSnapshotInput(path: string, maximum: number): string {
  return readPrivateRecoveryFile(canonicalInputPath(path), maximum);
}

/** The reviewed digest binds the private envelope; it does not enroll a source. */
export function readSnapshotEnvelope(path: string, expectedDigest: string): SnapshotImportEnvelope {
  const envelope = SnapshotImportEnvelope.parse(
    JSON.parse(readSnapshotInput(path, 8 * 1024 * 1024)),
  );
  const { digest, ...payload } = envelope;
  if (digest !== expectedDigest || sourceSnapshotDigest(payload) !== expectedDigest)
    throw new Error('Snapshot plan differs from reviewed digest');
  return envelope;
}
