import { z } from 'zod';
import type Database from 'better-sqlite3';
import { AuditEvent } from '@qmd-team-intent-kb/schema';

import {
  computeEntryHash,
  CURRENT_AUDIT_HASH_VERSION,
  type AuditHashVersion,
} from '../audit-chain.js';

/**
 * Zod schema for the raw SQLite row returned by better-sqlite3.
 * Validates the flat DB representation before domain parsing.
 *
 * `entry_hash` / `prev_entry_hash` are nullable to keep migration-5
 * backward-compatible: pre-migration rows have both as NULL; new rows
 * have both populated (modulo the first chained row, where
 * prev_entry_hash is NULL by design).
 *
 * `hash_version` is nullable/optional for the same reason against
 * migration 6: rows written before it have no column value (a stale read
 * model), rows after it default to 1, and new inserts write the CURRENT
 * version. Callers treat NULL/absent as v1.
 */
const AuditRowSchema = z.object({
  id: z.string(),
  action: z.string(),
  memory_id: z.string(),
  tenant_id: z.string(),
  actor_json: z.string(),
  reason: z.string().nullable(),
  details_json: z.string(),
  timestamp: z.string(),
  entry_hash: z.string().nullable().optional(),
  prev_entry_hash: z.string().nullable().optional(),
  hash_version: z.number().int().nullable().optional(),
});

/** Raw chronological row used by the audit verifier. */
export interface AuditChainRow {
  id: string;
  action: string;
  memory_id: string;
  tenant_id: string;
  actor_json: string;
  reason: string | null;
  details_json: string;
  timestamp: string;
  entry_hash: string | null;
  prev_entry_hash: string | null;
  /** Canonical-hash version (NULL/absent => 1, the original timestamp-in-hash form). */
  hash_version: number | null;
}

/**
 * Parse a raw SQLite row into a validated AuditEvent domain object.
 * Throws a descriptive error if the row fails validation.
 *
 * @param row - unknown value from better-sqlite3 .get()/.all()
 * @returns validated AuditEvent
 * @throws Error with row id and Zod issue details if parsing fails
 */
function rowToEvent(row: unknown): AuditEvent {
  const flatResult = AuditRowSchema.safeParse(row);
  if (!flatResult.success) {
    const issues = flatResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`audit_events row failed flat validation: ${issues.join('; ')}`);
  }
  const flat = flatResult.data;

  let actor: unknown;
  let details: unknown;

  try {
    actor = JSON.parse(flat.actor_json);
  } catch (e) {
    throw new Error(`audit_events row id=${flat.id}: actor_json is not valid JSON: ${String(e)}`);
  }
  try {
    details = JSON.parse(flat.details_json);
  } catch (e) {
    throw new Error(`audit_events row id=${flat.id}: details_json is not valid JSON: ${String(e)}`);
  }

  const domainResult = AuditEvent.safeParse({
    id: flat.id,
    action: flat.action,
    memoryId: flat.memory_id,
    tenantId: flat.tenant_id,
    actor,
    reason: flat.reason ?? undefined,
    details,
    timestamp: flat.timestamp,
  });

  if (!domainResult.success) {
    const issues = domainResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(
      `audit_events row id=${flat.id} failed domain validation: ${issues.join('; ')}`,
    );
  }

  return domainResult.data;
}

/**
 * Append-only repository for immutable audit events.
 * No update or delete methods are exposed by design.
 */
/** Pre-serialised inputs to the atomic append transaction. */
interface AppendParams {
  event: AuditEvent;
  actor_json: string;
  details_json: string;
  reason: string | null;
  hash_version: AuditHashVersion;
}

export class AuditRepository {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtFindByMemory: Database.Statement;
  private readonly stmtFindByMemoryAndTenant: Database.Statement;
  private readonly stmtFindByTenant: Database.Statement;
  private readonly stmtFindByAction: Database.Statement;
  private readonly stmtFindByTenantAndAction: Database.Statement;
  private readonly stmtCountByAction: Database.Statement;
  private readonly stmtFindInRange: Database.Statement;
  private readonly stmtCountByTenantAndAction: Database.Statement;
  private readonly stmtLastHash: Database.Statement;
  private readonly stmtFindAllChronological: Database.Statement;
  /** Atomic (BEGIN IMMEDIATE) prev-read + INSERT — see the constructor. */
  private readonly appendTxn: Database.Transaction<(p: AppendParams) => void>;

  constructor(db: Database.Database) {
    // `seq` is assigned MAX(seq)+1 atomically within the INSERT — a monotonic,
    // gap-tolerant write-order key (the chain orders by it, not by the
    // random-UUID `id`; bead yxp). The prev-hash read and this INSERT run inside
    // the BEGIN IMMEDIATE `appendTxn` below, so concurrent WAL writers cannot
    // interleave; the UNIQUE index on seq is a belt-and-suspenders guard.
    this.stmtInsert = db.prepare(`
      INSERT INTO audit_events (
        id, action, memory_id, tenant_id, actor_json, reason, details_json,
        timestamp, entry_hash, prev_entry_hash, hash_version, seq
      ) VALUES (
        @id, @action, @memory_id, @tenant_id, @actor_json, @reason, @details_json,
        @timestamp, @entry_hash, @prev_entry_hash, @hash_version,
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM audit_events)
      )
    `);

    // Most-recent hashed row, by monotonic write order (seq). Used by insert()
    // to anchor a new row's prev_entry_hash to the immediately-preceding
    // inserted row. Ordering by seq (not timestamp, id) is what keeps the
    // write-time prev link and the verifier walk in agreement on
    // same-timestamp pairs (bead yxp). Returns NULL when no chained history
    // exists yet (first post-migration insert, or empty table).
    this.stmtLastHash = db.prepare(`
      SELECT entry_hash FROM audit_events
      WHERE entry_hash IS NOT NULL
      ORDER BY seq DESC
      LIMIT 1
    `);

    // Chronological walk used by verifyAuditChain. Ordered by the monotonic
    // write-order key `seq` so it reproduces true insertion order — the order
    // in which the prev_entry_hash links were built. Ordering by (timestamp,
    // id) reordered same-timestamp pairs by random UUID and broke the chain
    // walk (bead yxp).
    this.stmtFindAllChronological = db.prepare(`
      SELECT * FROM audit_events ORDER BY seq ASC
    `);

    this.stmtFindByMemory = db.prepare(`
      SELECT * FROM audit_events WHERE memory_id = ? ORDER BY timestamp ASC
    `);

    // Tenant-scoped memory lookup — the safe path for any caller serving a
    // single tenant (e.g. an HTTP read API). Prevents a cross-tenant leak where
    // a known memory_id returns rows the caller's tenant does not own.
    this.stmtFindByMemoryAndTenant = db.prepare(`
      SELECT * FROM audit_events WHERE memory_id = ? AND tenant_id = ? ORDER BY timestamp ASC
    `);

    this.stmtFindByTenant = db.prepare(`
      SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY timestamp ASC
    `);

    this.stmtFindByAction = db.prepare(`
      SELECT * FROM audit_events WHERE action = ? ORDER BY timestamp ASC
    `);

    // Tenant-scoped action lookup — the safe path; an unscoped action query
    // returns every tenant's rows for that action.
    this.stmtFindByTenantAndAction = db.prepare(`
      SELECT * FROM audit_events WHERE tenant_id = ? AND action = ? ORDER BY timestamp ASC
    `);

    this.stmtCountByAction = db.prepare(`
      SELECT action, COUNT(*) as cnt FROM audit_events GROUP BY action
    `);

    this.stmtFindInRange = db.prepare(`
      SELECT * FROM audit_events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC
    `);

    this.stmtCountByTenantAndAction = db.prepare(`
      SELECT action, COUNT(*) as cnt FROM audit_events WHERE tenant_id = ? GROUP BY action
    `);

    // Serialize the prev-hash read + the INSERT in one BEGIN IMMEDIATE
    // transaction. Under WAL with two connections (e.g. the brain-api daemon and
    // a concurrent curator-cli run), an un-serialised read-then-insert lets both
    // writers read the SAME prev_entry_hash and persist a fork — two rows
    // pointing at one predecessor — which UNIQUE(seq) does NOT catch (each row
    // still gets a distinct seq). The immediate write lock makes appends atomic
    // so the chain stays linear (bead yxp; flagged by review).
    this.appendTxn = db.transaction((p: AppendParams): void => {
      const prevRow = this.stmtLastHash.get() as { entry_hash: string | null } | undefined;
      const prev_entry_hash = prevRow?.entry_hash ?? null;
      const entry_hash = computeEntryHash(
        {
          id: p.event.id,
          action: p.event.action,
          memory_id: p.event.memoryId,
          tenant_id: p.event.tenantId,
          actor_json: p.actor_json,
          reason: p.reason,
          details_json: p.details_json,
          timestamp: p.event.timestamp,
          prev_entry_hash,
        },
        p.hash_version,
      );
      this.stmtInsert.run({
        id: p.event.id,
        action: p.event.action,
        memory_id: p.event.memoryId,
        tenant_id: p.event.tenantId,
        actor_json: p.actor_json,
        reason: p.reason,
        details_json: p.details_json,
        timestamp: p.event.timestamp,
        entry_hash,
        prev_entry_hash,
        hash_version: p.hash_version,
      });
    });
  }

  /**
   * Append a new audit event. This is the only write operation permitted.
   *
   * Computes the SHA-256 hash chain at insert time: each new row's
   * `prev_entry_hash` equals the chronologically previous row's
   * `entry_hash`, or NULL if this is the first chained row in the table.
   * Tampering with any stored row will be detected by `verifyAuditChain`.
   *
   * New rows are written under the CURRENT hash version (v2, with `timestamp`
   * excluded from the canonical body), so the `entry_hash` is reproducible
   * across clones for the same logical event (bead `8da.6`). The version is
   * stored alongside the row so the verifier knows which serialiser to use.
   */
  insert(event: AuditEvent): void {
    // The prev-hash read, hash computation, and INSERT all happen inside the
    // immediate transaction so concurrent writers cannot fork the chain.
    this.appendTxn.immediate({
      event,
      actor_json: JSON.stringify(event.actor),
      details_json: JSON.stringify(event.details),
      reason: event.reason ?? null,
      hash_version: CURRENT_AUDIT_HASH_VERSION,
    });
  }

  /**
   * Return every audit row in monotonic write-order (`seq`, i.e. insertion
   * order) with the raw hash-chain columns intact. Used by the chain verifier;
   * `seq` ordering is what makes the walk match the order the prev-links were
   * built in, so same-timestamp pairs verify correctly (bead yxp).
   */
  findAllChronological(): AuditChainRow[] {
    return this.stmtFindAllChronological.all() as AuditChainRow[];
  }

  /**
   * Return all events associated with the given memory, in chronological order.
   *
   * NOTE: this is NOT tenant-scoped — it returns rows across all tenants for the
   * given memory_id. Any caller serving a single tenant (e.g. an HTTP read API)
   * MUST use {@link findByMemoryAndTenant} instead to avoid leaking another
   * tenant's audit rows. This unscoped method exists for internal /
   * operator-global use only.
   */
  findByMemory(memoryId: string): AuditEvent[] {
    const rows = this.stmtFindByMemory.all(memoryId);
    return rows.map(rowToEvent);
  }

  /**
   * Tenant-scoped memory lookup — the safe path for single-tenant callers.
   * Returns only the given tenant's audit events for the memory.
   */
  findByMemoryAndTenant(memoryId: string, tenantId: string): AuditEvent[] {
    const rows = this.stmtFindByMemoryAndTenant.all(memoryId, tenantId);
    return rows.map(rowToEvent);
  }

  /** Return all events for the given tenant, in chronological order. */
  findByTenant(tenantId: string): AuditEvent[] {
    const rows = this.stmtFindByTenant.all(tenantId);
    return rows.map(rowToEvent);
  }

  /**
   * Return all events of the given action type, in chronological order.
   *
   * NOTE: NOT tenant-scoped — returns every tenant's rows for the action.
   * Single-tenant callers MUST use {@link findByTenantAndAction}.
   */
  findByAction(action: string): AuditEvent[] {
    const rows = this.stmtFindByAction.all(action);
    return rows.map(rowToEvent);
  }

  /**
   * Tenant-scoped action lookup — the safe path for single-tenant callers.
   * Returns only the given tenant's audit events for the action.
   */
  findByTenantAndAction(tenantId: string, action: string): AuditEvent[] {
    const rows = this.stmtFindByTenantAndAction.all(tenantId, action);
    return rows.map(rowToEvent);
  }

  /** Count events grouped by action type */
  countByAction(): Record<string, number> {
    const rows = this.stmtCountByAction.all() as Array<{ action: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.action] = row.cnt;
    }
    return result;
  }

  /** Find events within a time range (ISO string comparison) */
  findInRange(startDate: string, endDate: string): AuditEvent[] {
    const rows = this.stmtFindInRange.all(startDate, endDate);
    return rows.map(rowToEvent);
  }

  /** Count events by action for a specific tenant */
  countByTenantAndAction(tenantId: string): Record<string, number> {
    const rows = this.stmtCountByTenantAndAction.all(tenantId) as Array<{
      action: string;
      cnt: number;
    }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.action] = row.cnt;
    }
    return result;
  }
}
