import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import type { Result } from '@qmd-team-intent-kb/common';
import { getSpoolPath } from '../config.js';

/**
 * Outcome of verifying a spool file against its manifest sidecar.
 *
 *  - `verified`    — manifest present and the file's SHA-256 matches.
 *  - `no_manifest` — no `<file>.manifest.json` next to the spool file.
 *                    Treated as a non-fatal "can't verify" — the ingest
 *                    path proceeds (backward compatible with spool files
 *                    written before manifests, or by producers that don't
 *                    write them). NOT treated as tamper.
 *  - `tampered`    — manifest present but the recomputed SHA-256 of the
 *                    spool file content does NOT match `spoolFileSha256`.
 *                    The ingest path MUST refuse the file.
 */
export type SpoolManifestStatus = 'verified' | 'no_manifest' | 'tampered';

/**
 * Receipt carried by a producer when a spool file represents a broad or bulk
 * import. The receipt is intentionally small and machine-verifiable: the
 * candidate count is checked against the JSONL and the ceiling is checked
 * before any candidate is inserted into the store.
 */
export interface SpoolBatchReceipt {
  /** Stable producer-run identity, persisted as candidates.import_batch_id. */
  batchId: string;
  /** Tenant boundary asserted by the producer and checked against every line. */
  tenantId: string;
  /** Discovery scope used to produce the file. */
  scope: 'wiki' | 'outputs' | 'all';
  /** Source stamp expected on every candidate in the batch. */
  source: 'import' | 'bulk_import';
  /** Trust stamp expected on every candidate in the batch. */
  trustLevel: 'high' | 'medium' | 'low' | 'untrusted';
  /** Exact number of valid candidates expected in this spool file. */
  candidateCount: number;
  /** Producer-declared per-run ceiling; candidateCount must not exceed it. */
  maxCandidates: number;
}

export interface SpoolManifestResult {
  status: SpoolManifestStatus;
  /** SHA-256 recorded in the manifest (present when status !== 'no_manifest'). */
  expected?: string;
  /** SHA-256 recomputed from the spool file content (present on verified/tampered). */
  actual?: string;
  /** Candidate IDs pinned by the producer manifest, when present. */
  candidateIds?: string[];
  /** Broad/bulk admission receipt, when present. */
  batchReceipt?: SpoolBatchReceipt;
}

function parseBatchReceipt(value: unknown): SpoolBatchReceipt | null {
  if (value === null || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const batchId = r['batchId'];
  const tenantId = r['tenantId'];
  const scope = r['scope'];
  const source = r['source'];
  const trustLevel = r['trustLevel'];
  const candidateCount = r['candidateCount'];
  const maxCandidates = r['maxCandidates'];
  const scopes = new Set(['wiki', 'outputs', 'all']);
  const sources = new Set(['import', 'bulk_import']);
  const trustLevels = new Set(['high', 'medium', 'low', 'untrusted']);
  if (
    typeof batchId !== 'string' ||
    batchId.length < 1 ||
    batchId.length > 128 ||
    typeof tenantId !== 'string' ||
    tenantId.length < 1 ||
    !scopes.has(String(scope)) ||
    !sources.has(String(source)) ||
    !trustLevels.has(String(trustLevel)) ||
    typeof candidateCount !== 'number' ||
    !Number.isSafeInteger(candidateCount) ||
    candidateCount < 0 ||
    typeof maxCandidates !== 'number' ||
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates < 1
  ) {
    return null;
  }
  return {
    batchId,
    tenantId,
    scope: scope as SpoolBatchReceipt['scope'],
    source: source as SpoolBatchReceipt['source'],
    trustLevel: trustLevel as SpoolBatchReceipt['trustLevel'],
    candidateCount,
    maxCandidates,
  };
}

/**
 * Verify a spool file against its manifest sidecar (bead `dmj.4`,
 * threat-model control C11 in 036-AT-THRT).
 *
 * ICO's emitter writes `<spool>.jsonl.manifest.json` carrying
 * `spoolFileSha256` = SHA-256 hex of the spool file body (UTF-8). This
 * function recomputes that hash from the on-disk content and compares,
 * giving INTKB tamper-detection at the spool boundary: a process that
 * modifies an ICO-written spool file between write and read is caught
 * before the JSONL is parsed.
 *
 * Pure — reads two files, no store / audit dependency. The caller
 * (curator's `ingestFromSpool`) owns the refuse + quarantine policy.
 */
export async function verifySpoolManifest(
  spoolFilePath: string,
): Promise<Result<SpoolManifestResult, string>> {
  const manifestPath = `${spoolFilePath}.manifest.json`;

  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, 'utf8');
  } catch {
    // No manifest sidecar — can't verify, but not a tamper signal.
    return { ok: true, value: { status: 'no_manifest' } };
  }

  let expected: string;
  try {
    const manifest = JSON.parse(manifestRaw) as {
      spoolFileSha256?: unknown;
      candidateIds?: unknown;
      batchReceipt?: unknown;
    };
    if (typeof manifest.spoolFileSha256 !== 'string' || manifest.spoolFileSha256.length === 0) {
      return {
        ok: false,
        error: `Manifest ${manifestPath} missing or invalid spoolFileSha256 field`,
      };
    }
    expected = manifest.spoolFileSha256;
    const candidateIds = Array.isArray(manifest.candidateIds)
      ? manifest.candidateIds.filter((id): id is string => typeof id === 'string')
      : undefined;
    let batchReceipt: SpoolBatchReceipt | undefined;
    if (manifest.batchReceipt !== undefined) {
      const parsedReceipt = parseBatchReceipt(manifest.batchReceipt);
      if (parsedReceipt === null) {
        return {
          ok: false,
          error: `Manifest ${manifestPath} contains an invalid batchReceipt`,
        };
      }
      batchReceipt = parsedReceipt;
    }

    // The receipt metadata is useful even when the caller has opted out of
    // hash verification; return it only after the manifest itself parsed.
    const metadata = { candidateIds, batchReceipt };

    let content: string;
    try {
      content = await readFile(spoolFilePath, 'utf8');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Failed to read spool file for verification: ${msg}` };
    }

    const actual = createHash('sha256').update(content, 'utf8').digest('hex');
    return {
      ok: true,
      value: {
        ...metadata,
        status: actual === expected ? 'verified' : 'tampered',
        expected,
        actual,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Manifest ${manifestPath} is not valid JSON: ${msg}` };
  }
}

/** Read and parse all candidates from a single spool file */
export async function readSpoolFile(filepath: string): Promise<Result<MemoryCandidate[], string>> {
  try {
    const content = await readFile(filepath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const candidates: MemoryCandidate[] = [];

    for (const line of lines) {
      const parsed = MemoryCandidate.safeParse(JSON.parse(line));
      if (parsed.success) {
        candidates.push(parsed.data);
      }
    }

    return { ok: true, value: candidates };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Failed to read spool file: ${msg}` };
  }
}

/** List all spool files in the spool directory */
export async function listSpoolFiles(spoolDir?: string): Promise<Result<string[], string>> {
  const dir = spoolDir ?? getSpoolPath();
  try {
    const files = await readdir(dir);
    const spoolFiles = files
      .filter((f) => f.startsWith('spool-') && f.endsWith('.jsonl'))
      .sort()
      .map((f) => join(dir, f));
    return { ok: true, value: spoolFiles };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Failed to list spool files: ${msg}` };
  }
}
