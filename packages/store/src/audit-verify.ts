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

import { computeEntryHash } from './audit-chain.js';
import type { AuditRepository, AuditChainRow } from './repositories/audit-repository.js';

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
  /** Machine-readable reason code. */
  reason: 'ENTRY_HASH_MISMATCH' | 'PREV_LINK_MISMATCH' | 'PREV_LINK_AND_ENTRY_HASH_MISMATCH';
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

    const expectedHash = computeEntryHash({
      id: row.id,
      action: row.action,
      memory_id: row.memory_id,
      tenant_id: row.tenant_id,
      actor_json: row.actor_json,
      reason: row.reason,
      details_json: row.details_json,
      timestamp: row.timestamp,
      prev_entry_hash: row.prev_entry_hash,
    });

    const prevMatches = row.prev_entry_hash === expectedPrev;
    const entryMatches = row.entry_hash === expectedHash;

    if (prevMatches && entryMatches) {
      cleanRows++;
      expectedPrev = row.entry_hash;
      continue;
    }

    let reason: AuditChainBreak['reason'];
    if (!prevMatches && !entryMatches) {
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

    // Re-anchor the chain on whatever the tampered row stored, so
    // subsequent rows aren't all reported as broken due to one tamper.
    // Same "honest accounting" pattern as ICO's audit-verify.ts.
    expectedPrev = row.entry_hash;
  }

  return {
    totalRows: rows.length,
    unverifiedRows,
    cleanRows,
    breaks,
  };
}
