/**
 * Audit-event hash-chain helpers (bead `kmr` / `gvt`).
 *
 * The `audit_events` table is structurally append-only (no UPDATE / DELETE
 * statements are exposed). Migration 5 (`add_audit_hash_chain`) added two
 * columns — `entry_hash` and `prev_entry_hash` — that turn the table into a
 * cryptographic hash chain. Tampering with any row's content invalidates
 * its `entry_hash` against the canonical recomputation; tampering with the
 * chain order invalidates `prev_entry_hash` linkage.
 *
 * Chain semantics:
 *  - First chained row has `prev_entry_hash = NULL` (no anchor).
 *  - Each subsequent row's `prev_entry_hash` equals the previous row's
 *    stored `entry_hash`.
 *  - `entry_hash = sha256(canonicalJson(rowWithPrevHashField))`.
 *
 * Pre-migration rows retain both columns as NULL and are flagged
 * `unverified` (not `broken`) by `verifyAuditChain`. Operators who require
 * cryptographic continuity over historical data can run a separate
 * backfill tool — out of scope for v1.
 *
 * Reference: ICO's analogous primitive in `kernel/src/audit-verify.ts`.
 * INTKB's chain is over a SQLite table, not per-day JSONL files, so the
 * walk is by `(timestamp, id)` order rather than file-by-file.
 *
 * @module audit-chain
 */

import { createHash } from 'node:crypto';

/**
 * Canonical row shape over which the hash is computed. Field order is
 * fixed by `canonicalRowJson` — do NOT reorder the keys without bumping
 * a migration that rehashes every row, or every existing chain breaks.
 */
export interface CanonicalAuditRow {
  id: string;
  action: string;
  memory_id: string;
  tenant_id: string;
  actor_json: string;
  reason: string | null;
  details_json: string;
  timestamp: string;
  prev_entry_hash: string | null;
}

/**
 * Serialise a canonical audit row to a stable JSON string. Field order is
 * hardcoded so the JSON.stringify output is deterministic across runtimes
 * (Node.js engines preserve insertion order, but we don't rely on the
 * caller doing so — we build a fresh object with the canonical order).
 */
export function canonicalRowJson(row: CanonicalAuditRow): string {
  return JSON.stringify({
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
}

/** Compute the SHA-256 hex digest of a canonical row. */
export function computeEntryHash(row: CanonicalAuditRow): string {
  return createHash('sha256').update(canonicalRowJson(row), 'utf8').digest('hex');
}
