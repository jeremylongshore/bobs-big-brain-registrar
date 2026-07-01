/**
 * provenance-integrity evaluator — is every curated memory's provenance sound,
 * and is the audit chain free of TAMPERING?
 *
 * Two layers of "can you trust this memory":
 *  1. Per-memory content integrity — does each memory's stored `contentHash`
 *     actually match the SHA-256 of its `content`? A mismatch means the content
 *     was altered after the fingerprint was recorded (tampering / corruption).
 *  2. Audit-chain integrity — does the store's append-only SHA-256 audit chain
 *     verify with NO tamper signatures?
 *
 * ## Why this changed (010-AT-RISK R5 / bead compile-then-govern-e06.2, umbrella #27)
 *
 * The old verdict was `passed = … && chain.breaks.length === 0`. That is
 * red-by-construction: `verifyAuditChain` returns EVERY break, including benign
 * `CHAIN_FORK` rows — a non-malicious same-timestamp ordering artifact where
 * every stored hash is intact (bead yxp). The live governed brain carries ~155
 * such forks and ZERO tampering, so the eval was `passed:false` forever,
 * contradicting the ratified posture ("a fork is not tampering").
 *
 * This evaluator now uses the merged 3-state classifier
 * (`classifyChainBreaks`, `@qmd-team-intent-kb/store`) to partition the breaks
 * into **tamper signatures**, **documented exceptions** (known-migration breaks
 * byte-pinned in the exception manifest — carried, not failed), and **chain
 * forks**. The verdict now passes on the SECURITY property:
 *
 *     passed = contentHashMismatches === 0
 *           && invalidSources     === 0
 *           && tamperSignatures.length === 0
 *
 * i.e. it fails ONLY on genuine tampering (a content-hash mismatch, an invalid
 * source, or a tamper-reason audit break not covered by a byte-pinned
 * exception). Benign `CHAIN_FORK`s do NOT fail — but they ARE disclosed in
 * `details` (`chain_forks`), alongside `tamper_signatures` and
 * `documented_exceptions`, so a forked-but-untampered chain reads as "clean
 * (integrity + ordering intact) with N disclosed forks", never as a silent
 * green nor a false red.
 *
 * ## The manifest (optional)
 *
 * If an exception manifest exists, documented (byte-pinned known-migration)
 * breaks are surfaced separately and never counted as tampering; ANY drift from
 * the pinned tuple flips such a break back to a tamper signature (no
 * laundering — see `exception-manifest.ts`). With no manifest (the default on
 * the live brain today, which carries only forks), every tamper-reason break is
 * a tamper signature and correctly fails. The manifest path is configurable
 * (`options.exceptionManifestPath` or `$TEAMKB_EXCEPTION_MANIFEST`, default
 * `~/.teamkb/audit/exceptions.manifest.json`); a missing file is not an error.
 *
 * Pure w.r.t. durable state: takes the memory + audit repositories, reads the
 * manifest file if present, returns a verdict. No emit, no sign. (Note:
 * `verifyAuditChain` walks the global chain by design — it is a single
 * append-only ledger across tenants. A tenant-scoped bundle-exposing API is a
 * separate hardening concern, tracked at bead tr08.21.)
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { computeContentHash } from '@qmd-team-intent-kb/common';
import type {
  AuditChainRow,
  AuditRepository,
  ExceptionManifest,
  MemoryRepository,
  StoredRowTuple,
} from '@qmd-team-intent-kb/store';
import { classifyChainBreaks, readManifest, verifyAuditChain } from '@qmd-team-intent-kb/store';

import type { EvaluatorResult } from './types.js';

const VALID_SOURCES = new Set(['claude_session', 'manual', 'import', 'mcp']);

/** Default on-disk location of a brain's byte-pinned exception manifest. */
const DEFAULT_EXCEPTION_MANIFEST_PATH = join(
  homedir(),
  '.teamkb',
  'audit',
  'exceptions.manifest.json',
);

export interface ProvenanceIntegrityOptions {
  /** Tenant to scope the per-memory content-integrity walk. Omit = all tenants. */
  readonly tenantId?: string;
  /**
   * Path to the byte-pinned exception manifest of documented known-migration
   * breaks. When omitted, falls back to `$TEAMKB_EXCEPTION_MANIFEST` then to
   * `~/.teamkb/audit/exceptions.manifest.json`. A missing file is NOT an error
   * (no amnesty → every tamper-reason break is a tamper signature).
   */
  readonly exceptionManifestPath?: string;
}

/**
 * `findAllChronological()` runs `SELECT *`, so the `seq` column is present on
 * each row object even though `AuditChainRow` does not declare it. Widen the
 * type to read it for the byte-pinned tuple, matching curator-cli's
 * generate-exception-manifest.
 */
type ChainRowWithSeq = AuditChainRow & { seq: number | null };

/**
 * Resolve + load the exception manifest, or return `null`. Fail-closed on a
 * PRESENT-but-corrupt manifest (readManifest throws), so a tampered amnesty
 * cannot silently launder breaks; treat a merely-absent file as "no amnesty".
 */
function loadManifest(explicitPath: string | undefined): ExceptionManifest | null {
  const path =
    explicitPath ?? process.env.TEAMKB_EXCEPTION_MANIFEST ?? DEFAULT_EXCEPTION_MANIFEST_PATH;
  if (!existsSync(path)) return null;
  // readManifest throws on a corrupt/edited manifest — let it propagate: a
  // present manifest that fails its own integrity gates must not be ignored.
  return readManifest(path);
}

/** Build the classifier's id → current-stored-tuple map from the live audit rows. */
function rowsByIdOf(rows: readonly ChainRowWithSeq[]): Map<string, StoredRowTuple> {
  const m = new Map<string, StoredRowTuple>();
  for (const r of rows) {
    m.set(r.id, {
      entry_hash: r.entry_hash,
      prev_entry_hash: r.prev_entry_hash,
      hash_version: r.hash_version ?? 1,
      seq: r.seq ?? 0,
    });
  }
  return m;
}

export function evaluateProvenanceIntegrity(
  memoryRepo: MemoryRepository,
  auditRepo: AuditRepository,
  options: ProvenanceIntegrityOptions = {},
): EvaluatorResult {
  const memories =
    options.tenantId !== undefined
      ? memoryRepo.findByTenant(options.tenantId)
      : allMemories(memoryRepo);

  let contentHashMismatches = 0;
  let invalidSources = 0;
  for (const m of memories) {
    if (computeContentHash(m.content) !== m.contentHash) contentHashMismatches += 1;
    if (!VALID_SOURCES.has(m.source)) invalidSources += 1;
  }

  const chain = verifyAuditChain(auditRepo);

  // Partition the breaks the walker found into tamper signatures, documented
  // (byte-pinned) exceptions, and benign CHAIN_FORKs, using the merged 3-state
  // classifier. `rowsById` is the CURRENT stored tuple of each row, so a
  // documented break that has since been re-touched byte-drifts and flips back
  // to a tamper signature (no laundering — see exception-manifest.ts).
  const manifest = loadManifest(options.exceptionManifestPath);
  const rows = auditRepo.findAllChronological() as ChainRowWithSeq[];
  const classified = classifyChainBreaks(chain.breaks, manifest, rowsByIdOf(rows));
  const tamperSignatures = classified.tamperSignatures.length;
  const documentedExceptions = classified.documentedExceptions.length;
  const chainForks = classified.chainForks.length;

  // Pass on the SECURITY property: genuine tampering only. Benign CHAIN_FORKs
  // and byte-pinned documented exceptions do NOT fail the verdict; they are
  // disclosed in `details` for honest reporting (010-AT-RISK R5).
  const passed = contentHashMismatches === 0 && invalidSources === 0 && tamperSignatures === 0;

  // Score: fraction of integrity checks that held. Only the GATING checks count
  // as failures (content-hash mismatch, invalid source, presence of tamper
  // signatures); benign forks / documented exceptions are NOT failures, so they
  // do not drag the score below the 1.0 threshold on an untampered-but-forked
  // brain. The chain contributes exactly one gating check (tamper-free or not),
  // matching the pre-fix denominator so a clean brain still scores 1.0.
  const totalChecks = memories.length * 2 + 1;
  const failedChecks = contentHashMismatches + invalidSources + (tamperSignatures > 0 ? 1 : 0);
  const score = totalChecks === 0 ? 1 : (totalChecks - failedChecks) / totalChecks;

  return {
    name: 'provenance-integrity',
    passed,
    score: Number(score.toFixed(4)),
    threshold: 1.0,
    details: {
      memories_checked: memories.length,
      content_hash_mismatches: contentHashMismatches,
      invalid_sources: invalidSources,
      audit_chain_rows: chain.totalRows,
      // The gating count: tamper-reason breaks NOT covered by a byte-pinned
      // exception. Zero on the live brain (155 forks, 0 tamper).
      tamper_signatures: tamperSignatures,
      // Disclosed-not-failed: benign same-timestamp ordering forks (bead yxp).
      chain_forks: chainForks,
      // Disclosed-not-failed: byte-pinned known-migration breaks (manifest).
      documented_exceptions: documentedExceptions,
      // Whether a byte-pinned exception manifest was loaded for this run.
      exception_manifest_loaded: manifest !== null,
    },
  };
}

/** Gather memories across all tenants via the per-tenant index. */
function allMemories(repo: MemoryRepository): ReturnType<MemoryRepository['findByTenant']> {
  const byTenant = repo.countByTenant();
  const out: ReturnType<MemoryRepository['findByTenant']> = [];
  for (const tenantId of Object.keys(byTenant)) {
    out.push(...repo.findByTenant(tenantId));
  }
  return out;
}
