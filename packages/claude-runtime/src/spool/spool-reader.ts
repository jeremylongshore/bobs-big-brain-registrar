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

export interface SpoolManifestResult {
  status: SpoolManifestStatus;
  /** SHA-256 recorded in the manifest (present when status !== 'no_manifest'). */
  expected?: string;
  /** SHA-256 recomputed from the spool file content (present on verified/tampered). */
  actual?: string;
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
    const manifest = JSON.parse(manifestRaw) as { spoolFileSha256?: unknown };
    if (typeof manifest.spoolFileSha256 !== 'string' || manifest.spoolFileSha256.length === 0) {
      return {
        ok: false,
        error: `Manifest ${manifestPath} missing or invalid spoolFileSha256 field`,
      };
    }
    expected = manifest.spoolFileSha256;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Manifest ${manifestPath} is not valid JSON: ${msg}` };
  }

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
    value: { status: actual === expected ? 'verified' : 'tampered', expected, actual },
  };
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
