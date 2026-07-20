import { z } from 'zod';
import type Database from 'better-sqlite3';

/** The last-successful-index tracking record for one tenant's search index. */
export interface IndexState {
  tenantId: string;
  /** ISO-8601 UTC instant of the last COMPLETED export→reindex chain. */
  lastIndexedAt: string;
  updatedAt: string;
}

/**
 * Zod schema for the raw SQLite row returned by better-sqlite3.
 * Validates the flat DB representation before mapping to IndexState.
 */
const IndexStateRowSchema = z.object({
  tenant_id: z.string(),
  last_indexed_at: z.string(),
  updated_at: z.string(),
});

/** Parse a raw SQLite row into a validated IndexState object. */
function rowToState(row: unknown): IndexState {
  const result = IndexStateRowSchema.safeParse(row);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`index_state row failed validation: ${issues.join('; ')}`);
  }
  const flat = result.data;
  return {
    tenantId: flat.tenant_id,
    lastIndexedAt: flat.last_indexed_at,
    updatedAt: flat.updated_at,
  };
}

/**
 * Tracks, per tenant, when the derived search index (kb-export markdown tree +
 * qmd/FTS5 index) last caught up with the governed store — the store half of the
 * D1/D2 freshness contract.
 *
 * Design choice — DERIVED dirty signal, not a written flag. The "index dirty"
 * marker is not a column any promotion path has to remember to set: a tenant's
 * index is dirty exactly when `curated_memories` holds a row whose `promoted_at`
 * is newer than this table's `last_indexed_at`. `promoted_at` is written inside
 * the promotion transaction (R9 — atomic with the memory + its receipt), so the
 * dirty signal is set "at promotion commit" by construction, for EVERY caller
 * (API promotion-service, curator batch, plugin govern sweep, merge-gate), and
 * can never desync the way a dual-written boolean could. This table only records
 * the CONSUME side: whoever completes the export→reindex chain calls
 * `markIndexed`, which is what "clears" the dirty state.
 *
 * Timestamp contract: `lastIndexedAt` MUST be an ISO-8601 UTC string
 * (`new Date().toISOString()` shape) so it is lexicographically comparable with
 * `curated_memories.promoted_at`, which the promoter writes in that format.
 * (Deliberately NOT `datetime('now')`, whose `YYYY-MM-DD HH:MM:SS` shape would
 * break the string comparison.)
 */
export class IndexStateRepository {
  private readonly stmtGet: Database.Statement;
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtOldestUnindexed: Database.Statement;
  private readonly stmtAll: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtGet = db.prepare(`
      SELECT * FROM index_state WHERE tenant_id = ?
    `);

    this.stmtUpsert = db.prepare(`
      INSERT INTO index_state (tenant_id, last_indexed_at, updated_at)
      VALUES (@tenant_id, @last_indexed_at, datetime('now'))
      ON CONFLICT(tenant_id) DO UPDATE SET
        last_indexed_at = excluded.last_indexed_at,
        updated_at = datetime('now')
    `);

    // The OLDEST promotion the index has not yet absorbed — worst-case
    // staleness, not the most recent one.
    this.stmtOldestUnindexed = db.prepare(`
      SELECT MIN(promoted_at) AS oldest FROM curated_memories
      WHERE tenant_id = ? AND promoted_at > ?
    `);

    this.stmtAll = db.prepare(`SELECT * FROM index_state`);
  }

  /** Return the index state for the given tenant, or null if never indexed. */
  get(tenantId: string): IndexState | null {
    const row = this.stmtGet.get(tenantId);
    return row !== undefined ? rowToState(row) : null;
  }

  /**
   * Record that the tenant's export→reindex chain COMPLETED at `lastIndexedAt`
   * (ISO-8601 UTC — see the class doc's timestamp contract). Call only after the
   * FULL chain succeeded; a half-run (export ok, reindex failed) must not mark,
   * or the staleness gauge would report fresh over a stale index.
   */
  markIndexed(tenantId: string, lastIndexedAt: string): void {
    this.stmtUpsert.run({
      tenant_id: tenantId,
      last_indexed_at: lastIndexedAt,
    });
  }

  /**
   * Seconds since the OLDEST promotion not yet reflected in the tenant's index.
   *
   * Return contract (D2, documented for `QmdHealthStatus.stalenessSeconds`):
   *   - `null`  — staleness is UNMEASURED: no `index_state` row exists yet for
   *               this tenant (no export→reindex chain has ever recorded
   *               completion). Deliberately fail-open: on first deploy of this
   *               table every pre-existing memory predates measurement, and
   *               treating them all as "un-indexed" would fire a false
   *               staleness alarm across every healthy brain. Measurement
   *               starts with the first `markIndexed`.
   *   - `0`     — measured and fresh: every promotion is at or before
   *               `last_indexed_at`.
   *   - `> 0`   — measured and stale: seconds elapsed (by `nowMs`) since the
   *               oldest promotion the index has not absorbed.
   */
  stalenessSeconds(tenantId: string, nowMs: number = Date.now()): number | null {
    const state = this.get(tenantId);
    if (state === null) return null;

    const row = this.stmtOldestUnindexed.get(tenantId, state.lastIndexedAt) as
      { oldest: string | null } | undefined;
    const oldest = row?.oldest ?? null;
    if (oldest === null) return 0;

    const oldestMs = Date.parse(oldest);
    if (Number.isNaN(oldestMs)) return 0;
    return Math.max(0, Math.floor((nowMs - oldestMs) / 1000));
  }

  /**
   * The worst (largest) per-tenant staleness across every tenant that has begun
   * measurement, or `null` when no tenant has an `index_state` row yet. The
   * process-level health surface (`GET /api/health`) uses this because health is
   * not tenant-scoped.
   */
  worstStalenessSeconds(nowMs: number = Date.now()): number | null {
    const rows = this.stmtAll.all() as unknown[];
    let worst: number | null = null;
    for (const raw of rows) {
      const state = rowToState(raw);
      const s = this.stalenessSeconds(state.tenantId, nowMs);
      if (s !== null && (worst === null || s > worst)) worst = s;
    }
    return worst;
  }
}
