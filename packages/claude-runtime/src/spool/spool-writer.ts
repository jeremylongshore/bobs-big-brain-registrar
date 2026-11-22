import {
  hasUnsupportedSourceEvidence,
  SOURCE_EVIDENCE_UNSUPPORTED,
} from '@qmd-team-intent-kb/schema';
import { mkdir, appendFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Result } from '@qmd-team-intent-kb/common';
import { isPathSafe } from '@qmd-team-intent-kb/common';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { getSpoolPath, getSpoolFilename } from '../config.js';

/**
 * Append a memory candidate to a JSONL spool file.
 *
 * When `agentId` is provided, each agent gets its own spool file to prevent
 * interleaved writes from concurrent sessions.
 *
 * Path traversal: the resolved filepath is validated against the spool
 * directory to prevent writes outside the allowed root.
 */
export async function writeToSpool(
  candidate: MemoryCandidate,
  spoolDir?: string,
  agentId?: string,
): Promise<Result<string, string>> {
  if (hasUnsupportedSourceEvidence(candidate))
    return { ok: false, error: SOURCE_EVIDENCE_UNSUPPORTED };
  const dir = spoolDir ?? getSpoolPath();
  const filename = agentId ? `spool-${agentId}.jsonl` : getSpoolFilename();
  const filepath = resolve(dir, filename);

  // Path traversal guard: ensure resolved path stays within the spool directory
  const resolvedDir = resolve(dir);
  if (!filepath.startsWith(resolvedDir + '/') && filepath !== resolvedDir) {
    return { ok: false, error: `Path traversal rejected: ${filename}` };
  }

  const safety = isPathSafe(filename);
  if (!safety.safe) {
    return { ok: false, error: `Unsafe spool filename: ${safety.reason}` };
  }

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(candidate) + '\n';
    await appendFile(filepath, line, 'utf8');
    // Best-effort file permissions
    try {
      await chmod(filepath, 0o600);
    } catch {
      // Ignore permission errors on platforms that don't support chmod
    }
    return { ok: true, value: filepath };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Failed to write to spool: ${msg}` };
  }
}
