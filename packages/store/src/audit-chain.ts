/**
 * Audit-event hash-chain helpers (bead `kmr` / `gvt`; determinism `8da.6`).
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
 * Hash versioning (bead `8da.6`, cross-clone determinism):
 *  - `hash_version = 1` (original): the canonical body INCLUDES `timestamp`.
 *    Two clones processing the same logical event at different wallclock
 *    instants mint different `timestamp` values, so they produce different
 *    `entry_hash` values, so the chain is per-clone, not reproducible.
 *  - `hash_version = 2` (migration 6, `rehash_audit_chain_v2`): the canonical
 *    body EXCLUDES `timestamp`. `entry_hash` is then a pure function of the
 *    logical event `(id, action, memory_id, tenant_id, actor_json, reason,
 *    details_json, prev_entry_hash)`, identical across clones for the same
 *    event. `timestamp` is still STORED on the row (un-hashed); chain order
 *    is still protected by `prev_entry_hash`, which never depended on the
 *    timestamp's value.
 *
 * Both serialisers are FROZEN. Each is the tamper-evidence contract for the
 * rows written under its version: changing either silently invalidates the
 * stored hashes for every row that used it. A future canonical-body change
 * MUST land as a new `hash_version` + migration, never as an edit here.
 * v1 rows are deliberately NOT rehashed to v2: their v1 hashes are the
 * tamper record; rehashing them would erase the evidence of any past edit.
 *
 * @module audit-chain
 */

import { createHash } from 'node:crypto';

/**
 * The canonical-hash version a row was written under. Selects which
 * serialiser `computeEntryHash` uses. Rows with a NULL/absent column are
 * treated as v1 (the original timestamp-in-hash form) by every caller.
 */
export type AuditHashVersion = 1 | 2;

/** The hash version every NEW row is written under. */
export const CURRENT_AUDIT_HASH_VERSION: AuditHashVersion = 2;

/**
 * Canonical row shape over which the hash is computed. Field order is
 * fixed by the per-version serialisers: do NOT reorder the keys (or add
 * `timestamp` back into the v2 body) without bumping a NEW migration that
 * defines a fresh `hash_version`, or every existing chain breaks.
 *
 * `timestamp` is retained on the type because the v1 serialiser still
 * hashes it. v2 callers may pass it; the v2 serialiser ignores it.
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
 * v1 serialiser (FROZEN). The original canonical body, with `timestamp`
 * inside the hash. Retained verbatim so historical v1 rows recompute to
 * their stored hash. Never edit this: it is the tamper-evidence contract
 * for every row written before migration 6.
 */
function canonicalRowJsonV1(row: CanonicalAuditRow): string {
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

/**
 * v2 serialiser (FROZEN, bead `8da.6`). The canonical body with `timestamp`
 * EXCLUDED. The result depends only on fields that are identical across
 * clones for the same logical event, so the hash is reproducible: hash the
 * same event twice with different wallclocks and get the same `entry_hash`.
 * Chain ordering is unaffected: it rides on `prev_entry_hash`.
 */
function canonicalRowJsonV2(row: CanonicalAuditRow): string {
  return JSON.stringify({
    id: row.id,
    action: row.action,
    memory_id: row.memory_id,
    tenant_id: row.tenant_id,
    actor_json: row.actor_json,
    reason: row.reason,
    details_json: row.details_json,
    prev_entry_hash: row.prev_entry_hash,
  });
}

/**
 * Serialise a canonical audit row to a stable JSON string under the given
 * hash version. Field order is hardcoded per version so the JSON.stringify
 * output is deterministic across runtimes (Node.js engines preserve
 * insertion order, but we don't rely on the caller doing so: we build a
 * fresh object with the canonical order). Defaults to the CURRENT version.
 */
export function canonicalRowJson(
  row: CanonicalAuditRow,
  hashVersion: AuditHashVersion = CURRENT_AUDIT_HASH_VERSION,
): string {
  return hashVersion === 1 ? canonicalRowJsonV1(row) : canonicalRowJsonV2(row);
}

/**
 * Compute the SHA-256 hex digest of a canonical row under the given hash
 * version. Defaults to the CURRENT version (v2, timestamp excluded, so the
 * digest is reproducible across clones). Pass `1` when recomputing the hash
 * of a legacy row stored under the original timestamp-in-hash serialiser.
 */
export function computeEntryHash(
  row: CanonicalAuditRow,
  hashVersion: AuditHashVersion = CURRENT_AUDIT_HASH_VERSION,
): string {
  return createHash('sha256').update(canonicalRowJson(row, hashVersion), 'utf8').digest('hex');
}
