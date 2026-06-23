/**
 * Audit-chain integrity verifier (bead `kmr` / `gvt`).
 *
 * Walks every audit_events row in chronological order, recomputes each
 * row's `entry_hash` from its canonical content + the previous row's
 * stored `entry_hash`, and reports any break (stored hash !== expected
 * hash) plus the row's identifying fields. Also flags pre-migration
 * rows (NULL entry_hash) as `unverified` rather than `broken`.
 *
 * Used by `curator-cli verify-audit-chain` and (downstream) by ICO's
 * `scripts/demo-e2e.sh` stage 7 as the INTKB-side companion to
 * `ico audit verify`. The two together cover the auditor-verification
 * journey's hash-chain steps (4-5) per `tests/JOURNEYS.md`.
 *
 * The verifier returns a structured `AuditVerifyResult` — operators
 * (and `curator-cli`) consume the result; the kernel never throws on a
 * tampered chain, only on actual I/O failure.
 *
 * @module audit-verify
 */

import { computeEntryHash, type AuditHashVersion } from './audit-chain.js';
import type { AuditRepository, AuditChainRow } from './repositories/audit-repository.js';

/**
 * Resolve a row's stored hash version to the discriminant the serialiser
 * understands. A NULL/absent column (rows that predate migration 6, or any
 * value other than 2) is treated as the original v1 timestamp-in-hash form.
 */
function rowHashVersion(row: AuditChainRow): AuditHashVersion {
  return row.hash_version === 2 ? 2 : 1;
}

/** Per-row finding from the chain walk. */
export interface AuditChainBreak {
  /** Zero-indexed position in the chronological walk where the break occurred. */
  index: number;
  /** Audit row's primary key — names the offending entry uniquely. */
  id: string;
  /** Action + timestamp + tenant give the operator enough to triage. */
  action: string;
  timestamp: string;
  tenantId: string;
  /** Hash computed by walking the row's current content. */
  expectedEntryHash: string;
  /** Hash actually stored in the row. */
  actualEntryHash: string | null;
  /** Hash chain link expected based on the previous row's entry_hash. */
  expectedPrevEntryHash: string | null;
  actualPrevEntryHash: string | null;
  /**
   * Machine-readable reason code.
   *
   * The first three are TAMPERING signatures (a stored hash no longer matches
   * recomputation, or a prev link points at a value no prior row ever held).
   *
   * `CHAIN_FORK` is NOT tampering: the row's own content hash is intact AND its
   * `prev_entry_hash` points back to a real, already-walked earlier row — just
   * not its immediate predecessor. A pre-fix writer ordered same-timestamp
   * events by a random-UUID tiebreak, so a later insert linked past its sibling
   * and one predecessor ended up with two children. Every hash is intact; the
   * chain merely is not linear at that point. Callers that need a tamper-only
   * view filter this reason out (see `curator-cli verify-audit-chain`); it still
   * counts against a STRICT clean chain. See bead qmd-team-intent-kb-yxp.
   */
  reason:
    | 'ENTRY_HASH_MISMATCH'
    | 'PREV_LINK_MISMATCH'
    | 'PREV_LINK_AND_ENTRY_HASH_MISMATCH'
    | 'CHAIN_FORK';
}

/** Aggregate result of a chain-verification pass. */
export interface AuditVerifyResult {
  /** Total rows walked (intact + unverified + broken). */
  totalRows: number;
  /** Pre-migration rows (entry_hash IS NULL) — not counted as breaks. */
  unverifiedRows: number;
  /** Rows whose stored entry_hash matches the recomputed hash. */
  cleanRows: number;
  /** Per-break details; empty array means the chain is intact. */
  breaks: AuditChainBreak[];
}

/**
 * Walk the audit chain in chronological order, validating each chained
 * row against the recomputed expected hash.
 *
 * @param repo  AuditRepository providing chronological row access.
 * @returns A structured AuditVerifyResult. Never throws on tamper —
 *          surfaces breaks via the `breaks` array. Throws only on
 *          actual I/O failure inside better-sqlite3.
 */
export function verifyAuditChain(repo: AuditRepository): AuditVerifyResult {
  const rows: AuditChainRow[] = repo.findAllChronological();
  const breaks: AuditChainBreak[] = [];
  let unverifiedRows = 0;
  let cleanRows = 0;

  // The hash chain is built from the previous CHAINED row's entry_hash,
  // skipping any leading or interspersed pre-migration rows. The walk
  // tracks `expectedPrev` separately from the row index so that a
  // tampered prev_entry_hash on row N reports against the correct
  // expected anchor.
  let expectedPrev: string | null = null;

  // Stored entry_hashes of every already-walked row WHOSE OWN HASH MATCHED.
  // Used to tell a CHAIN_FORK (a prev link pointing back to a real, intact
  // earlier row) apart from a forged PREV_LINK_MISMATCH (a prev pointing at a
  // value no intact row holds). Only intact rows are valid fork anchors, so a
  // tampered row's stored hash can never excuse a later row as non-tampering.
  const seenEntryHashes = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;

    // Pre-migration row (both hash columns NULL): record and continue
    // without advancing the expected chain. We do NOT count this as a
    // break — the operator already knows pre-migration rows are
    // structurally unverifiable.
    if (row.entry_hash === null && row.prev_entry_hash === null) {
      unverifiedRows++;
      continue;
    }

    // Recompute under the SAME hash version the row was written with, so a
    // mixed v1/v2 table verifies in a single pass (bead 8da.6). v1 rows hash
    // their timestamp; v2 rows do not.
    const expectedHash = computeEntryHash(
      {
        id: row.id,
        action: row.action,
        memory_id: row.memory_id,
        tenant_id: row.tenant_id,
        actor_json: row.actor_json,
        reason: row.reason,
        details_json: row.details_json,
        timestamp: row.timestamp,
        prev_entry_hash: row.prev_entry_hash,
      },
      rowHashVersion(row),
    );

    const prevMatches = row.prev_entry_hash === expectedPrev;
    const entryMatches = row.entry_hash === expectedHash;

    if (prevMatches && entryMatches) {
      cleanRows++;
      expectedPrev = row.entry_hash;
      if (row.entry_hash !== null) seenEntryHashes.add(row.entry_hash);
      continue;
    }

    let reason: AuditChainBreak['reason'];
    if (entryMatches && row.prev_entry_hash !== null && seenEntryHashes.has(row.prev_entry_hash)) {
      // Own content hash intact, and the prev link points back to a real
      // earlier row we already walked — a non-malicious ordering fork, not
      // tampering (bead yxp). It still fails a STRICT clean chain, but a
      // tamper-only view (curator-cli) filters it out.
      reason = 'CHAIN_FORK';
    } else if (!prevMatches && !entryMatches) {
      reason = 'PREV_LINK_AND_ENTRY_HASH_MISMATCH';
    } else if (!prevMatches) {
      reason = 'PREV_LINK_MISMATCH';
    } else {
      reason = 'ENTRY_HASH_MISMATCH';
    }

    breaks.push({
      index: i,
      id: row.id,
      action: row.action,
      timestamp: row.timestamp,
      tenantId: row.tenant_id,
      expectedEntryHash: expectedHash,
      actualEntryHash: row.entry_hash,
      expectedPrevEntryHash: expectedPrev,
      actualPrevEntryHash: row.prev_entry_hash,
      reason,
    });

    // Re-anchor the chain on whatever this row stored, so subsequent rows
    // aren't all reported as broken due to one fork/tamper. Same "honest
    // accounting" pattern as ICO's audit-verify.ts.
    expectedPrev = row.entry_hash;
    // Only a row whose OWN hash matched may anchor a later CHAIN_FORK; a broken
    // row's stored hash must not let a successor be excused as non-tampering.
    if (entryMatches && row.entry_hash !== null) seenEntryHashes.add(row.entry_hash);
  }

  return {
    totalRows: rows.length,
    unverifiedRows,
    cleanRows,
    breaks,
  };
}
