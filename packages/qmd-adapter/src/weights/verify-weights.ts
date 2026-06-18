import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computeFileHash } from '@qmd-team-intent-kb/common';

/**
 * Model-weight integrity pinning for the retrieval brain.
 *
 * qmd's semantic path (hybrid `qmd query` / `qmd embed`, and the future native
 * sqlite-vec backend) runs GGUF model weights via llama.cpp. Those weights are
 * downloaded to a local cache and, until now, were neither signed nor pinned —
 * a govern-by-receipts product cannot run an unverified retrieval brain.
 *
 * This module pins each weight by SHA-256 + byte size in a manifest and verifies
 * the on-disk copies against it. `assertWeightsVerified` is the **fail-closed**
 * gate: any semantic path MUST call it before touching the models, and it throws
 * on any mismatch rather than silently using a tampered/swapped weight.
 *
 * See ADR `000-docs/038-AT-DECR` and bead `qmd-team-intent-kb-0t9.5`.
 */

/** One pinned model weight. */
export interface PinnedModel {
  /** Stable id (embedding | reranker | query-expansion). */
  id: string;
  /** Role in the retrieval pipeline. */
  role: 'embedding' | 'reranker' | 'query-expansion';
  /** File name as stored in the qmd models cache. */
  file: string;
  /** Pinned SHA-256 (hex) of the file. */
  sha256: string;
  /** Pinned byte size — a cheap pre-check before hashing GB-scale files. */
  size: number;
  /** Hugging Face source repo (informational provenance). */
  hfRepo?: string;
}

/** The pinned weight manifest — the "receipts" for the retrieval brain. */
export interface WeightsManifest {
  schemaVersion: number;
  /** The qmd package + version these weights belong to. */
  qmd: { npmPackage: string; version: string };
  /** Free-text caveat (e.g. which qmd version the hashes were captured under). */
  note?: string;
  models: PinnedModel[];
}

export type ModelVerifyStatus = 'ok' | 'missing' | 'size-mismatch' | 'hash-mismatch';

export interface ModelVerifyResult {
  id: string;
  file: string;
  status: ModelVerifyStatus;
  expectedSha256: string;
  actualSha256?: string;
  expectedSize: number;
  actualSize?: number;
}

export interface WeightsVerifyResult {
  ok: boolean;
  modelsDir: string;
  results: ModelVerifyResult[];
}

/** Thrown by `assertWeightsVerified` when one or more weights fail the pin. */
export class WeightIntegrityError extends Error {
  constructor(public readonly result: WeightsVerifyResult) {
    const bad = result.results.filter((r) => r.status !== 'ok');
    super(
      `qmd model-weight integrity check FAILED (fail-closed) in ${result.modelsDir}: ` +
        bad.map((r) => `${r.id} [${r.status}]`).join(', ') +
        ". The retrieval brain's weights do not match the pinned manifest — refusing to use them.",
    );
    this.name = 'WeightIntegrityError';
  }
}

/**
 * Resolve qmd's GGUF models directory. qmd stores them under its XDG cache, so
 * this honors `XDG_CACHE_HOME` (matching the adapter's per-tenant XDG isolation)
 * and falls back to `~/.cache`.
 */
export function resolveQmdModelsDir(env: NodeJS.ProcessEnv = process.env): string {
  const cacheHome = env['XDG_CACHE_HOME']?.trim() || join(homedir(), '.cache');
  return join(cacheHome, 'qmd', 'models');
}

/**
 * Verify every pinned weight against its on-disk copy. Pure check: returns the
 * per-model result and never throws (use `assertWeightsVerified` to fail closed).
 * Order of checks per model: existence → size → SHA-256 (so a cheap size diff
 * short-circuits before hashing a multi-GB file).
 */
export async function verifyWeights(
  manifest: WeightsManifest,
  modelsDir: string = resolveQmdModelsDir(),
): Promise<WeightsVerifyResult> {
  const results: ModelVerifyResult[] = [];

  for (const model of manifest.models) {
    const path = join(modelsDir, model.file);
    const base: ModelVerifyResult = {
      id: model.id,
      file: model.file,
      status: 'ok',
      expectedSha256: model.sha256,
      expectedSize: model.size,
    };

    if (!existsSync(path)) {
      results.push({ ...base, status: 'missing' });
      continue;
    }

    const actualSize = statSync(path).size;
    base.actualSize = actualSize;
    if (actualSize !== model.size) {
      results.push({ ...base, status: 'size-mismatch' });
      continue;
    }

    const actualSha256 = await computeFileHash(path);
    base.actualSha256 = actualSha256;
    if (actualSha256 !== model.sha256) {
      results.push({ ...base, status: 'hash-mismatch' });
      continue;
    }

    results.push(base);
  }

  return { ok: results.every((r) => r.status === 'ok'), modelsDir, results };
}

/**
 * Fail-closed gate. Verifies the weights and THROWS `WeightIntegrityError` on any
 * mismatch. Call this before ANY semantic retrieval path (qmd query / embed /
 * native vector backend) loads the models. Returns the (passing) result on success.
 */
export async function assertWeightsVerified(
  manifest: WeightsManifest,
  modelsDir: string = resolveQmdModelsDir(),
): Promise<WeightsVerifyResult> {
  const result = await verifyWeights(manifest, modelsDir);
  if (!result.ok) {
    throw new WeightIntegrityError(result);
  }
  return result;
}
