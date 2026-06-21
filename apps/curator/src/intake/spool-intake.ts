import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  listSpoolFiles,
  readSpoolFile,
  verifySpoolManifest,
} from '@qmd-team-intent-kb/claude-runtime';
import { computeContentHash, DisclosureRejectedError } from '@qmd-team-intent-kb/common';
import type { Result } from '@qmd-team-intent-kb/common';
import type { CandidateRepository } from '@qmd-team-intent-kb/store';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';

/** Options for `ingestFromSpool`. All optional — defaults preserve the
 *  pre-`dmj.4` behavior except that manifest verification is now ON. */
export interface IngestFromSpoolOptions {
  /**
   * When true (default), each spool file is verified against its
   * `<file>.manifest.json` SHA-256 sidecar before parsing. A mismatch
   * means the file was modified after ICO wrote it — the file is refused
   * (its candidates are NOT ingested) and quarantined. Set false to skip
   * verification entirely (e.g. for producers that don't write manifests
   * and where the operator has accepted the risk).
   */
  verifyManifest?: boolean;
  /**
   * Directory tampered spool files are moved to. Defaults to
   * `<spoolDir>/quarantine`. Each quarantined file gets a
   * `<file>.tamper.json` evidence sidecar recording the hash mismatch.
   */
  quarantineDir?: string;
}

/** Record of a spool file refused during ingest because it failed manifest
 *  verification. Returned to the caller for surfacing / logging. */
export interface SpoolTamperRecord {
  spoolFile: string;
  expectedSha256: string | undefined;
  actualSha256: string | undefined;
  quarantinedTo: string | null;
}

/** A spool candidate refused at the disclosure / secret choke point. Carries
 *  only the candidate id + violated category — never the matched value. */
export interface SpoolDisclosureRejection {
  candidateId: string;
  category: string;
}

/** Result payload from `ingestFromSpoolDetailed`. */
export interface IngestResult {
  ingested: MemoryCandidate[];
  /** Files refused because their manifest SHA-256 did not match (tamper). */
  tampered: SpoolTamperRecord[];
  /**
   * Candidates refused at the repository-layer disclosure / secret choke point
   * (Epic 0). One poisoned candidate is skipped without aborting the batch —
   * fail-closed on the bad candidate, not a denial-of-service on the whole spool.
   */
  rejected: SpoolDisclosureRejection[];
}

/**
 * Reads spool files from the given directory (or default spool path) and inserts
 * new candidates into the candidate repository.
 *
 * Deduplication is ID-based: if a candidate with the same ID already exists in
 * the store it is silently skipped to prevent re-ingestion on repeated runs.
 * Unreadable or malformed spool files are skipped without aborting the batch.
 *
 * **Manifest verification (bead `dmj.4`, threat-model control C11):** each
 * spool file is checked against its `<file>.manifest.json` SHA-256 sidecar
 * before parsing. A mismatch means the file was modified after ICO wrote it;
 * the file is refused and quarantined rather than ingested. Files without a
 * manifest are ingested as before (can't-verify, not tamper).
 *
 * @returns ok with the list of newly-ingested candidates, or err if the spool
 *          directory itself cannot be accessed. Tamper events are a
 *          side-effect (quarantine + evidence sidecar); use
 *          `ingestFromSpoolDetailed` to receive the tamper records.
 */
export async function ingestFromSpool(
  candidateRepo: CandidateRepository,
  spoolDir?: string,
  opts?: IngestFromSpoolOptions,
): Promise<Result<MemoryCandidate[], string>> {
  const detailed = await ingestFromSpoolDetailed(candidateRepo, spoolDir, opts);
  if (!detailed.ok) return detailed;
  return { ok: true, value: detailed.value.ingested };
}

/**
 * Same as `ingestFromSpool` but returns the full `IngestResult` including
 * the list of tampered (refused + quarantined) files. Callers that want to
 * surface tamper events (e.g. `curator-cli`) use this variant.
 */
export async function ingestFromSpoolDetailed(
  candidateRepo: CandidateRepository,
  spoolDir?: string,
  opts?: IngestFromSpoolOptions,
): Promise<Result<IngestResult, string>> {
  const verifyManifest = opts?.verifyManifest ?? true;

  const filesResult = await listSpoolFiles(spoolDir);
  if (!filesResult.ok) return filesResult;

  const ingested: MemoryCandidate[] = [];
  const tampered: SpoolTamperRecord[] = [];
  const rejected: SpoolDisclosureRejection[] = [];

  for (const filepath of filesResult.value) {
    if (verifyManifest) {
      const verify = await verifySpoolManifest(filepath);
      // A verification *error* (malformed manifest JSON, unreadable file)
      // is treated like an unreadable spool file: skip, keep processing.
      if (!verify.ok) continue;
      if (verify.value.status === 'tampered') {
        const quarantinedTo = await quarantineTamperedFile(
          filepath,
          spoolDir,
          opts?.quarantineDir,
          verify.value.expected,
          verify.value.actual,
        );
        tampered.push({
          spoolFile: filepath,
          expectedSha256: verify.value.expected,
          actualSha256: verify.value.actual,
          quarantinedTo,
        });
        continue; // refuse: do NOT parse or ingest a tampered file
      }
      // 'verified' and 'no_manifest' both fall through to ingest.
    }

    const readResult = await readSpoolFile(filepath);
    if (!readResult.ok) continue; // skip unreadable files, keep processing others

    for (const candidate of readResult.value) {
      const existing = candidateRepo.findById(candidate.id);
      if (existing !== null) continue;

      const hash = computeContentHash(candidate.content);
      try {
        // The repository-layer choke point (Epic 0) rejects PII / comp / secret
        // content before it can be written. Refuse this one candidate and keep
        // processing the rest of the batch — a poisoned spool entry must not be
        // able to block every other candidate's ingest.
        candidateRepo.insert(candidate, hash);
        ingested.push(candidate);
      } catch (e) {
        if (e instanceof DisclosureRejectedError) {
          // Record only the id + category — never the matched value.
          rejected.push({ candidateId: candidate.id, category: e.category });
          continue;
        }
        throw e;
      }
    }
  }

  return { ok: true, value: { ingested, tampered, rejected } };
}

/**
 * Move a tampered spool file (and its manifest, if present) into a
 * quarantine directory and drop a `<file>.tamper.json` evidence sidecar
 * recording the hash mismatch + detection time. Best-effort: on any I/O
 * failure the function returns null (the file is still refused; quarantine
 * is defence-in-depth, not the load-bearing protection).
 */
async function quarantineTamperedFile(
  spoolFilePath: string,
  spoolDir: string | undefined,
  quarantineDirOverride: string | undefined,
  expected: string | undefined,
  actual: string | undefined,
): Promise<string | null> {
  try {
    const baseDir = quarantineDirOverride ?? join(spoolDir ?? '.', 'quarantine');
    await mkdir(baseDir, { recursive: true });

    const name = basename(spoolFilePath);
    const dest = join(baseDir, name);

    // Evidence sidecar first — if the rename fails we still have the record.
    const evidence = {
      spoolFile: name,
      detectedAt: new Date().toISOString(),
      expectedSha256: expected ?? null,
      actualSha256: actual ?? null,
      reason: 'SPOOL_TAMPERED: manifest SHA-256 mismatch on ingest',
    };
    await writeFile(`${dest}.tamper.json`, JSON.stringify(evidence, null, 2) + '\n', 'utf8');

    await rename(spoolFilePath, dest);
    // Move the manifest alongside if it exists (ignore if it doesn't).
    try {
      await rename(`${spoolFilePath}.manifest.json`, `${dest}.manifest.json`);
    } catch {
      // manifest may not exist or already moved — non-fatal
    }
    return dest;
  } catch {
    return null;
  }
}
