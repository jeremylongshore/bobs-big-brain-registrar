import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  ReviewJudgmentCase,
  ReviewJudgmentPrediction,
  ReviewRecallFloors,
  scoreReviewJudgments,
} from './review-agent-judgment.js';

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Id = ReviewJudgmentCase.shape.id;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DATASET_BYTES = 64 * MAX_FILE_BYTES;
const Manifest = z
  .object({
    schemaVersion: z.literal(1),
    datasetId: Id,
    kind: z.enum(['synthetic', 'human-reviewed']),
    revision: z.number().int().positive(),
    previousManifestSha256: Hash.nullable(),
    recallFloors: ReviewRecallFloors,
    cases: z
      .array(z.object({ id: Id, sha256: Hash }).strict())
      .min(1)
      .max(10000),
  })
  .strict();
const CaseFile = ReviewJudgmentCase.extend({
  schemaVersion: z.literal(1),
  input: z.object({ candidate: z.string().min(1), context: z.array(z.string()) }).strict(),
  disposition: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('synthetic') }).strict(),
    z
      .object({
        kind: z.literal('human'),
        reviewerIdSha256: Hash,
        evidenceSha256: Hash,
      })
      .strict(),
  ]),
}).strict();
const PredictionFile = z
  .object({
    schemaVersion: z.literal(1),
    manifestSha256: Hash,
    predictions: z.array(ReviewJudgmentPrediction).max(10000),
  })
  .strict();

export interface FrozenReviewOptions {
  root: string;
  /** Supplied independently of the dataset, not read from its own manifest. */
  manifestSha256: string;
  /** Independently trusted prior checkpoint. Required for revisions after one. */
  previous?: { manifestPath: string; sha256: string };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function json(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
}
function refuse(): never {
  throw new Error('Invalid frozen review evaluation evidence');
}
function same(a: ReturnType<typeof stamp>, b: ReturnType<typeof stamp>): boolean {
  return a === b;
}
function stamp(path: string): string {
  const s = lstatSync(path, { bigint: true });
  return [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
}
function directory(path: string): string {
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) refuse();
  return stamp(path);
}
/** Bounded regular-file reads reject redirected ancestors, symlinks and hardlinks. */
function readRegular(path: string): Buffer {
  if (realpathSync(dirname(path)) !== dirname(path)) refuse();
  const initial = stamp(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      !named.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_FILE_BYTES) ||
      before.dev !== named.dev ||
      before.ino !== named.ino
    )
      refuse();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, size);
      if (n === 0) break;
      size += n;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      size !== Number(before.size) ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      !same(initial, stamp(path))
    )
      refuse();
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
function parseManifest(bytes: Buffer, expected: string) {
  Hash.parse(expected);
  if (sha256(bytes) !== expected) refuse();
  const manifest = Manifest.parse(json(bytes));
  if (new Set(manifest.cases.map((item) => item.id)).size !== manifest.cases.length) refuse();
  if ((manifest.revision === 1) !== (manifest.previousManifestSha256 === null)) refuse();
  return manifest;
}
function checkAppend(
  manifest: z.infer<typeof Manifest>,
  previous: FrozenReviewOptions['previous'],
) {
  if (manifest.revision === 1) {
    if (manifest.previousManifestSha256 !== null || previous !== undefined) refuse();
    return;
  }
  if (!previous || manifest.previousManifestSha256 !== previous.sha256) refuse();
  const prior = parseManifest(readRegular(resolve(previous.manifestPath)), previous.sha256);
  if (
    prior.revision + 1 !== manifest.revision ||
    prior.datasetId !== manifest.datasetId ||
    prior.kind !== manifest.kind ||
    JSON.stringify(prior.recallFloors) !== JSON.stringify(manifest.recallFloors) ||
    prior.cases.length >= manifest.cases.length
  )
    refuse();
  for (const [index, item] of prior.cases.entries()) {
    const next = manifest.cases[index];
    if (!next || item.id !== next.id || item.sha256 !== next.sha256) refuse();
  }
}
function equalInventory(path: string, names: string[]) {
  if (JSON.stringify(readdirSync(path).sort()) !== JSON.stringify([...names].sort())) refuse();
}

/** Content integrity and append preservation, not human authentication or semantic truth. */
function capture(options: FrozenReviewOptions) {
  const root = resolve(options.root);
  const rootStamp = directory(root);
  const caseDir = join(root, 'cases');
  const caseStamp = directory(caseDir);
  equalInventory(root, ['manifest.json', 'cases']);
  const manifestPath = join(root, 'manifest.json');
  const manifestStamp = stamp(manifestPath);
  const manifestBytes = readRegular(manifestPath);
  const manifest = parseManifest(manifestBytes, options.manifestSha256);
  checkAppend(manifest, options.previous);
  const caseNames = manifest.cases.map((item) => `${item.id}.json`);
  equalInventory(caseDir, caseNames);
  const fileStamps = new Map<string, string>();
  let totalBytes = manifestBytes.length;
  const cases = manifest.cases.map((item) => {
    const path = join(caseDir, `${item.id}.json`);
    fileStamps.set(path, stamp(path));
    const bytes = readRegular(path);
    totalBytes += bytes.length;
    if (totalBytes > MAX_DATASET_BYTES || sha256(bytes) !== item.sha256) refuse();
    const row = CaseFile.parse(json(bytes));
    if (
      row.id !== item.id ||
      (manifest.kind === 'synthetic'
        ? row.disposition.kind !== 'synthetic'
        : row.disposition.kind !== 'human')
    )
      refuse();
    return ReviewJudgmentCase.parse({ id: row.id, expected: row.expected, stratum: row.stratum });
  });
  equalInventory(root, ['manifest.json', 'cases']);
  equalInventory(caseDir, caseNames);
  if (
    !same(rootStamp, directory(root)) ||
    !same(caseStamp, directory(caseDir)) ||
    !same(manifestStamp, stamp(manifestPath))
  )
    refuse();
  for (const [path, expected] of fileStamps) if (!same(expected, stamp(path))) refuse();
  return { manifest, cases };
}
function protectedRead<T>(action: () => T): T {
  try {
    return action();
  } catch {
    return refuse();
  }
}
function summary(manifest: z.infer<typeof Manifest>, manifestSha256: string) {
  return {
    schemaVersion: 1 as const,
    datasetId: manifest.datasetId,
    kind: manifest.kind,
    revision: manifest.revision,
    manifestSha256,
    caseCount: manifest.cases.length,
    previousManifestSha256: manifest.previousManifestSha256,
    humanAuthorizationVerified: false as const,
  };
}

export function verifyFrozenReviewDataset(options: FrozenReviewOptions) {
  return protectedRead(() => {
    const { manifest } = capture(options);
    return { integrity: 'verified' as const, ...summary(manifest, options.manifestSha256) };
  });
}

/** Predictions name the exact verified manifest; absent rows remain scored misses. */
export function scoreFrozenReviewDataset(options: FrozenReviewOptions, predictionsPath: string) {
  return protectedRead(() => {
    const { manifest, cases } = capture(options);
    const predictionsBytes = readRegular(resolve(predictionsPath));
    const predictions = PredictionFile.parse(json(predictionsBytes));
    if (predictions.manifestSha256 !== options.manifestSha256) refuse();
    return {
      dataset: summary(manifest, options.manifestSha256),
      predictionsSha256: sha256(predictionsBytes),
      ...scoreReviewJudgments(cases, predictions.predictions, manifest.recallFloors),
    };
  });
}
