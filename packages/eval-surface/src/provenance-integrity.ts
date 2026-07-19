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
 * ## The external-anchor cross-check (Track F2)
 *
 * `verifyAuditChain` re-anchors on each row's STORED `entry_hash`, so a local
 * writer who edits history AND re-hashes every later row forward still verifies
 * clean — and a wholesale truncation of the newest rows leaves a shorter but
 * internally-consistent chain. The anchor log (`audit-anchor.ts`, committed to
 * a force-push-protected git remote by the govern path) is the witness that
 * makes those rewrites DETECTABLE — not impossible. This evaluator therefore
 * ALSO cross-checks the chain against the anchor log via `verifyAnchors`, but
 * it does NOT use `verifyAnchors(...).ok`: that raw boolean is
 * `chain.breaks.length === 0 && …`, which is red-by-construction on the live
 * brain (the ~155 carried forks above). Instead the verdict is composed:
 *
 *   - chain breaks    → the 3-state classifier (forks + byte-pinned documented
 *                       exceptions disclosed-not-failed; tamper signatures fail)
 *   - anchor breaks   → ALWAYS fail closed, partitioned for the report into
 *                       `HISTORY_TRUNCATED` (chain now shorter than an anchored
 *                       snapshot), `HISTORY_REWRITTEN` (the head at an anchored
 *                       position changed — the rewrite `verifyAuditChain` alone
 *                       cannot see), and anchor-LOG integrity breaks
 *                       (`ANCHOR_HASH_MISMATCH` / `ANCHOR_LINK_MISMATCH`: the
 *                       witness log itself was edited or spliced).
 *
 * There is no benign anchor break: benign forks live on the CHAIN side (they
 * are write-time ordering artifacts, anchored as-is), so any live-chain vs
 * anchor divergence is treated as evidence of a post-anchor rewrite. Bootstrap
 * is graceful: a missing or empty anchor log reports
 * `anchor_status: 'no_anchors_yet'` and does NOT fail — a brain that has never
 * anchored has nothing to diverge from. The anchor-log path is configurable
 * (`options.anchorLogPath` or `$TEAMKB_ANCHOR_LOG`, default
 * `~/.teamkb/audit/anchors.jsonl`).
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
  AnchorBreak,
  AuditChainRow,
  AuditRepository,
  ExceptionManifest,
  MemoryRepository,
  StoredRowTuple,
} from '@qmd-team-intent-kb/store';
import { classifyChainBreaks, readManifest, verifyAnchors } from '@qmd-team-intent-kb/store';

import type { EvaluatorResult } from './types.js';

const VALID_SOURCES = new Set(['claude_session', 'manual', 'import', 'mcp']);

/** Default on-disk location of a brain's byte-pinned exception manifest. */
const DEFAULT_EXCEPTION_MANIFEST_PATH = join(
  homedir(),
  '.teamkb',
  'audit',
  'exceptions.manifest.json',
);

/** Default on-disk location of a brain's external anchor log. */
const DEFAULT_ANCHOR_LOG_PATH = join(homedir(), '.teamkb', 'audit', 'anchors.jsonl');

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
  /**
   * Path to the external anchor log (JSONL of `AnchorRecord`s appended by the
   * govern path). When omitted, falls back to `$TEAMKB_ANCHOR_LOG` then to
   * `~/.teamkb/audit/anchors.jsonl`. A missing or empty log is the graceful
   * bootstrap case (`anchor_status: 'no_anchors_yet'`), NOT a failure; any
   * live-chain vs anchor divergence fails closed.
   */
  readonly anchorLogPath?: string;
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

/**
 * The fail-closed partition of anchor breaks for the report. Every anchor
 * break gates the verdict (there is no benign anchor divergence — see the
 * module doc); the partition exists so the report says WHICH rewrite class
 * was detected, matching the 3-state discipline used for chain breaks.
 */
interface AnchorBreakCounts {
  historyTruncated: number;
  historyRewritten: number;
  /** ANCHOR_HASH_MISMATCH + ANCHOR_LINK_MISMATCH — the witness log itself edited/spliced. */
  logIntegrity: number;
}

function countAnchorBreaks(breaks: readonly AnchorBreak[]): AnchorBreakCounts {
  const counts: AnchorBreakCounts = { historyTruncated: 0, historyRewritten: 0, logIntegrity: 0 };
  for (const b of breaks) {
    if (b.reason === 'HISTORY_TRUNCATED') counts.historyTruncated += 1;
    else if (b.reason === 'HISTORY_REWRITTEN') counts.historyRewritten += 1;
    else counts.logIntegrity += 1;
  }
  return counts;
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

  // Cross-check the chain against the external anchor log. We deliberately do
  // NOT consume `anchorResult.ok` — it folds in `chain.breaks.length === 0`,
  // which is red-by-construction on the live brain's carried forks. The chain
  // breaks go through the 3-state classifier below; only the ANCHOR breaks
  // (all fail-closed) are taken from this result.
  const anchorLogPath =
    options.anchorLogPath ?? process.env.TEAMKB_ANCHOR_LOG ?? DEFAULT_ANCHOR_LOG_PATH;
  const anchorResult = verifyAnchors(auditRepo, anchorLogPath);
  const chain = anchorResult.chain;
  const anchorCounts = countAnchorBreaks(anchorResult.anchorBreaks);
  const anchorDiverged = anchorResult.anchorBreaks.length > 0;
  // Bootstrap: a brain that has never anchored has nothing to diverge from.
  const anchorStatus =
    anchorResult.anchorCount === 0 ? 'no_anchors_yet' : anchorDiverged ? 'divergent' : 'consistent';

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
  // disclosed in `details` for honest reporting (010-AT-RISK R5). ANY anchor
  // divergence fails closed: the chain may verify internally clean after a
  // full re-hash or a truncation — the anchor cross-check is exactly the
  // witness that catches those (F2). Bootstrap (no anchors yet) is vacuously
  // consistent, so `anchorDiverged` is false and does not fail.
  const passed =
    contentHashMismatches === 0 &&
    invalidSources === 0 &&
    tamperSignatures === 0 &&
    !anchorDiverged;

  // Score: fraction of integrity checks that held. Only the GATING checks count
  // as failures (content-hash mismatch, invalid source, presence of tamper
  // signatures, anchor divergence); benign forks / documented exceptions are
  // NOT failures, so they do not drag the score below the 1.0 threshold on an
  // untampered-but-forked brain. The chain contributes one gating check
  // (tamper-free or not) and the anchor cross-check one more (consistent — or
  // vacuously so at bootstrap — or not), so a clean brain still scores 1.0.
  const totalChecks = memories.length * 2 + 2;
  const failedChecks =
    contentHashMismatches +
    invalidSources +
    (tamperSignatures > 0 ? 1 : 0) +
    (anchorDiverged ? 1 : 0);
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
      // ---- external-anchor cross-check (F2) — every break below GATES ----
      // Snapshots in the anchor log this chain was cross-checked against.
      anchor_count: anchorResult.anchorCount,
      // 'no_anchors_yet' (bootstrap, vacuous pass) | 'consistent' | 'divergent'.
      anchor_status: anchorStatus,
      // Chain now has FEWER rows than an anchored snapshot recorded.
      anchor_history_truncated: anchorCounts.historyTruncated,
      // The head at an anchored position changed — the re-hash-forward rewrite
      // that intra-chain verification alone cannot see.
      anchor_history_rewritten: anchorCounts.historyRewritten,
      // The witness log itself was edited or spliced (hash/link mismatch).
      anchor_log_integrity_breaks: anchorCounts.logIntegrity,
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
