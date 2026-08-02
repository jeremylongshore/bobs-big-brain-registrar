import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  listSpoolFiles,
  readSpoolFile,
  verifySpoolManifest,
  type SpoolBatchReceipt,
  type SpoolManifestResult,
} from '@qmd-team-intent-kb/claude-runtime';
import { computeContentHash, DisclosureRejectedError } from '@qmd-team-intent-kb/common';
import type { Result } from '@qmd-team-intent-kb/common';
import type { CandidateRepository, ImportBatchRepository } from '@qmd-team-intent-kb/store';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';

/** A file above this size is broad-import material even if it uses `import`. */
export const DEFAULT_BROAD_IMPORT_CANDIDATE_LIMIT = 100;

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
  /**
   * When set, each spool file is MOVED here after its candidates are
   * successfully read + ingested (B1, bead compile-then-govern-jfv.2.1). Bounds
   * the nightly sweep's re-read work and makes a re-run over unchanged input a
   * genuine no-op: the auto-govern job re-runs every night but `listSpoolFiles`
   * only lists the top-level spool dir, so an already-ingested file in the
   * archive subdir is never re-read (or re-manifest-verified). The candidate
   * `findById` dedup already prevents a re-INSERT; archiving additionally stops
   * the O(all-spool-files-ever) growth in read/verify work. Best-effort: a move
   * failure is logged, never fatal (findById still guards correctness). The
   * `<file>.manifest.json` sidecar moves alongside. Left unset by the daemon/CLI
   * (their behavior is unchanged); the plugin's nightly `runGovern` sets it to
   * `<spool>/ingested`.
   */
  archiveIngestedDir?: string;
  /**
   * Durable batch ledger used for broad/bulk spool admission. Production CLI
   * and daemon wiring supplies this; ordinary single-source spool files remain
   * backward-compatible without it.
   */
  importBatchRepo?: ImportBatchRepository;
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

/** A broad/bulk file refused before any candidate is inserted. */
export interface SpoolAdmissionRejection {
  spoolFile: string;
  reason: string;
  batchId?: string;
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
  /** Broad/bulk files refused before insertion because their receipt was absent or invalid. */
  admissionRejected: SpoolAdmissionRejection[];
}

function requiresBatchReceipt(
  candidates: MemoryCandidate[],
  broadLimit = DEFAULT_BROAD_IMPORT_CANDIDATE_LIMIT,
  manifest?: SpoolManifestResult,
): boolean {
  return (
    manifest?.batchReceipt !== undefined ||
    candidates.some((candidate) => candidate.source === 'bulk_import') ||
    candidates.length > broadLimit
  );
}

function validateBatchReceipt(
  receipt: SpoolBatchReceipt | undefined,
  manifest: SpoolManifestResult | undefined,
  candidates: MemoryCandidate[],
): string | null {
  if (receipt === undefined) return 'missing batchReceipt in the spool manifest';
  if (manifest?.status !== 'verified') {
    return 'batchReceipt requires a manifest whose spool-file hash verifies';
  }
  if (receipt.candidateCount !== candidates.length) {
    return `batchReceipt candidateCount=${receipt.candidateCount} does not match parsed candidate count=${candidates.length}`;
  }
  if (receipt.candidateCount > receipt.maxCandidates) {
    return `batchReceipt candidateCount=${receipt.candidateCount} exceeds maxCandidates=${receipt.maxCandidates}`;
  }
  const candidateIds = manifest.candidateIds;
  if (candidateIds === undefined || candidateIds.length !== candidates.length) {
    return 'batchReceipt requires manifest candidateIds for every parsed candidate';
  }
  const expectedIds = new Set(candidateIds);
  if (expectedIds.size !== candidates.length || candidates.some((c) => !expectedIds.has(c.id))) {
    return 'manifest candidateIds do not match the parsed candidate IDs';
  }
  for (const candidate of candidates) {
    if (candidate.tenantId !== receipt.tenantId) {
      return `candidate ${candidate.id} tenantId does not match batchReceipt tenantId`;
    }
    if (candidate.source !== receipt.source) {
      return `candidate ${candidate.id} source does not match batchReceipt source`;
    }
    if (candidate.trustLevel !== receipt.trustLevel) {
      return `candidate ${candidate.id} trustLevel does not match batchReceipt trustLevel`;
    }
  }
  if (
    receipt.source === 'bulk_import' &&
    receipt.trustLevel !== 'low' &&
    receipt.trustLevel !== 'untrusted'
  ) {
    return "bulk_import batchReceipt must use trustLevel 'low' or 'untrusted'";
  }
  return null;
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
  const admissionRejected: SpoolAdmissionRejection[] = [];
  const importBatchRepo = opts?.importBatchRepo;

  for (const filepath of filesResult.value) {
    let manifest: SpoolManifestResult | undefined;
    if (verifyManifest) {
      const verify = await verifySpoolManifest(filepath);
      // A verification *error* (malformed manifest JSON, unreadable file)
      // is treated like an unreadable spool file: skip, keep processing.
      if (!verify.ok) {
        admissionRejected.push({ spoolFile: filepath, reason: verify.error });
        continue;
      }
      manifest = verify.value;
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

    const candidates = readResult.value;
    if (requiresBatchReceipt(candidates, DEFAULT_BROAD_IMPORT_CANDIDATE_LIMIT, manifest)) {
      // A caller may disable ordinary manifest verification for legacy files,
      // but broad/bulk admission always performs it. This prevents the escape
      // hatch from becoming a way around the batch receipt contract.
      if (manifest === undefined) {
        const verify = await verifySpoolManifest(filepath);
        if (!verify.ok) {
          admissionRejected.push({ spoolFile: filepath, reason: verify.error });
          continue;
        }
        manifest = verify.value;
      }
      const receiptError = validateBatchReceipt(manifest.batchReceipt, manifest, candidates);
      if (receiptError !== null) {
        admissionRejected.push({
          spoolFile: filepath,
          reason: receiptError,
          batchId: manifest.batchReceipt?.batchId,
        });
        continue;
      }
      if (importBatchRepo === undefined) {
        admissionRejected.push({
          spoolFile: filepath,
          reason: 'durable import batch repository is required for broad/bulk admission',
          batchId: manifest.batchReceipt?.batchId,
        });
        continue;
      }
    }

    const receipt = manifest?.batchReceipt;
    let batchCreated = 0;
    let batchRejected = 0;
    let batchSkipped = 0;
    let batchWasExisting = false;

    if (receipt !== undefined) {
      if (importBatchRepo === undefined) {
        // This is unreachable for a validated broad/bulk file, but keeps the
        // receipt path fail-closed if the admission rules change later.
        admissionRejected.push({
          spoolFile: filepath,
          reason: 'durable import batch repository is required for batch receipts',
          batchId: receipt.batchId,
        });
        continue;
      }
      const existingBatch = importBatchRepo.findById(receipt.batchId);
      batchWasExisting = existingBatch !== null;
      if (!batchWasExisting) {
        try {
          importBatchRepo.insert({
            id: receipt.batchId,
            tenantId: receipt.tenantId,
            sourcePath: filepath,
            fileCount: 1,
            createdCount: 0,
            rejectedCount: 0,
            skippedCount: 0,
            status: 'active',
            createdAt: new Date().toISOString(),
            rolledBackAt: null,
          });
        } catch (e) {
          admissionRejected.push({
            spoolFile: filepath,
            reason: `failed to persist batch receipt: ${e instanceof Error ? e.message : String(e)}`,
            batchId: receipt.batchId,
          });
          continue;
        }
      }
    }

    for (const candidate of candidates) {
      const existing = candidateRepo.findById(candidate.id);
      if (existing !== null) {
        batchSkipped++;
        continue;
      }

      const hash = computeContentHash(candidate.content);
      try {
        // The repository-layer choke point (Epic 0) rejects PII / comp / secret
        // content before it can be written. Refuse this one candidate and keep
        // processing the rest of the batch — a poisoned spool entry must not be
        // able to block every other candidate's ingest.
        candidateRepo.insert(candidate, hash, receipt?.batchId);
        ingested.push(candidate);
        batchCreated++;
      } catch (e) {
        if (e instanceof DisclosureRejectedError) {
          // Record only the id + category — never the matched value.
          rejected.push({ candidateId: candidate.id, category: e.category });
          batchRejected++;
          continue;
        }
        throw e;
      }
    }

    if (receipt !== undefined && !batchWasExisting && importBatchRepo !== undefined) {
      importBatchRepo.updateCounts(receipt.batchId, {
        fileCount: 1,
        createdCount: batchCreated,
        rejectedCount: batchRejected,
        skippedCount: batchSkipped,
      });
      importBatchRepo.complete(receipt.batchId);
    }

    // Idempotency (B1): once a file's candidates are read + ingested, move it out
    // of the top-level spool dir so subsequent runs never re-read/re-verify it.
    // Best-effort — a failed move is logged but not fatal (findById dedup already
    // prevents any re-insert).
    if (opts?.archiveIngestedDir !== undefined) {
      await archiveIngestedFile(filepath, opts.archiveIngestedDir);
    }
  }

  return { ok: true, value: { ingested, tampered, rejected, admissionRejected } };
}

/**
 * Move a fully-ingested spool file (and its `.manifest.json` sidecar, if present)
 * into the archive directory (B1). Best-effort: any I/O failure is swallowed after
 * a stderr note — the file simply stays in the spool dir and is skipped next run
 * via the candidate `findById` dedup, so correctness never depends on this move.
 */
async function archiveIngestedFile(spoolFilePath: string, archiveDir: string): Promise<void> {
  try {
    await mkdir(archiveDir, { recursive: true });
    const dest = join(archiveDir, basename(spoolFilePath));
    await rename(spoolFilePath, dest);
    try {
      await rename(`${spoolFilePath}.manifest.json`, `${dest}.manifest.json`);
    } catch {
      // manifest may not exist — non-fatal.
    }
  } catch (e) {
    process.stderr.write(
      `[spool-intake] archive skipped for ${basename(spoolFilePath)}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
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
