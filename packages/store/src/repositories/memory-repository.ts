import { z } from 'zod';
import type Database from 'better-sqlite3';
import { CuratedMemory } from '@qmd-team-intent-kb/schema';
import type { MemoryLifecycleState } from '@qmd-team-intent-kb/schema';

/**
 * Zod schema for the raw SQLite row returned by better-sqlite3.
 * Validates the flat DB representation before domain parsing.
 */
const MemoryRowSchema = z.object({
  id: z.string(),
  candidate_id: z.string(),
  source: z.string(),
  content: z.string(),
  title: z.string(),
  category: z.string(),
  trust_level: z.string(),
  sensitivity: z.string(),
  author_json: z.string(),
  tenant_id: z.string(),
  metadata_json: z.string(),
  lifecycle: z.string(),
  content_hash: z.string(),
  policy_evaluations_json: z.string(),
  supersession_json: z.string().nullable(),
  promoted_at: z.string(),
  promoted_by_json: z.string(),
  updated_at: z.string(),
  version: z.number(),
});

/**
 * Parse a raw SQLite row into a validated CuratedMemory domain object.
 * Throws a descriptive error if the row fails validation.
 *
 * @param row - unknown value from better-sqlite3 .get()/.all()
 * @returns validated CuratedMemory
 * @throws Error with row id and Zod issue details if parsing fails
 */
function rowToMemory(row: unknown): CuratedMemory {
  const flatResult = MemoryRowSchema.safeParse(row);
  if (!flatResult.success) {
    const issues = flatResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`curated_memories row failed flat validation: ${issues.join('; ')}`);
  }
  const flat = flatResult.data;

  let author: unknown;
  let metadata: unknown;
  let policyEvaluations: unknown;
  let supersession: unknown;
  let promotedBy: unknown;

  try {
    author = JSON.parse(flat.author_json);
  } catch (e) {
    throw new Error(
      `curated_memories row id=${flat.id}: author_json is not valid JSON: ${String(e)}`,
    );
  }
  try {
    metadata = JSON.parse(flat.metadata_json);
  } catch (e) {
    throw new Error(
      `curated_memories row id=${flat.id}: metadata_json is not valid JSON: ${String(e)}`,
    );
  }
  try {
    policyEvaluations = JSON.parse(flat.policy_evaluations_json);
  } catch (e) {
    throw new Error(
      `curated_memories row id=${flat.id}: policy_evaluations_json is not valid JSON: ${String(e)}`,
    );
  }
  if (flat.supersession_json !== null) {
    try {
      supersession = JSON.parse(flat.supersession_json);
    } catch (e) {
      throw new Error(
        `curated_memories row id=${flat.id}: supersession_json is not valid JSON: ${String(e)}`,
      );
    }
  }
  try {
    promotedBy = JSON.parse(flat.promoted_by_json);
  } catch (e) {
    throw new Error(
      `curated_memories row id=${flat.id}: promoted_by_json is not valid JSON: ${String(e)}`,
    );
  }

  const domainResult = CuratedMemory.safeParse({
    id: flat.id,
    candidateId: flat.candidate_id,
    source: flat.source,
    content: flat.content,
    title: flat.title,
    category: flat.category,
    trustLevel: flat.trust_level,
    sensitivity: flat.sensitivity,
    author,
    tenantId: flat.tenant_id,
    metadata,
    lifecycle: flat.lifecycle,
    contentHash: flat.content_hash,
    policyEvaluations,
    supersession,
    promotedAt: flat.promoted_at,
    promotedBy,
    updatedAt: flat.updated_at,
    version: flat.version,
  });

  if (!domainResult.success) {
    const issues = domainResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(
      `curated_memories row id=${flat.id} failed domain validation: ${issues.join('; ')}`,
    );
  }

  return domainResult.data;
}

/**
 * Append optional tenantId and category IN-list filters to a WHERE conditions array.
 * Mutates `conditions` and `params` in place — no allocation on the caller's behalf.
 *
 * @param conditions - Accumulator of SQL WHERE clauses
 * @param params     - Named-parameter map for the prepared statement
 * @param tenantId   - Optional tenant filter value
 * @param categories - Optional category allow-list
 * @param prefix     - Column name prefix, e.g. `'cm.'` for aliased queries or `''` for bare
 */
function appendOptionalFilters(
  conditions: string[],
  params: Record<string, string>,
  tenantId: string | undefined,
  categories: string[] | undefined,
  prefix: string,
): void {
  if (tenantId !== undefined) {
    conditions.push(`${prefix}tenant_id = @tenantId`);
    params['tenantId'] = tenantId;
  }

  if (categories !== undefined && categories.length > 0) {
    const placeholders = categories.map((_, i) => `@cat${i}`);
    conditions.push(`${prefix}category IN (${placeholders.join(', ')})`);
    categories.forEach((cat, i) => {
      params[`cat${i}`] = cat;
    });
  }
}

/**
 * Repository for governance-approved curated memories.
 * All methods use prepared statements. Validation is the caller's responsibility.
 */
export class MemoryRepository {
  private readonly db: Database.Database;
  private readonly hasFts5: boolean;
  private readonly stmtInsert: Database.Statement;
  private readonly stmtFindById: Database.Statement;
  private readonly stmtFindByTenant: Database.Statement;
  private readonly stmtFindByHash: Database.Statement;
  private readonly stmtFindByHashAndTenant: Database.Statement;
  private readonly stmtTenantHashes: Database.Statement;
  private readonly stmtFindByLifecycle: Database.Statement;
  private readonly stmtUpdateLifecycle: Database.Statement;
  private readonly stmtUpdate: Database.Statement;
  private readonly stmtCount: Database.Statement;
  private readonly stmtAllHashes: Database.Statement;
  private readonly stmtCountByLifecycle: Database.Statement;
  private readonly stmtCountByCategory: Database.Statement;
  private readonly stmtCountByTenant: Database.Statement;
  private readonly stmtFindStale: Database.Statement;
  private readonly stmtFindByTenantAndLifecycle: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // Detect FTS5 availability — the virtual table may not exist on older DBs
    try {
      db.prepare(
        "SELECT 1 FROM curated_memories_fts WHERE curated_memories_fts MATCH 'test' LIMIT 0",
      ).run();
      this.hasFts5 = true;
    } catch {
      this.hasFts5 = false;
    }

    this.stmtInsert = db.prepare(`
      INSERT INTO curated_memories (
        id, candidate_id, source, content, title, category,
        trust_level, sensitivity, author_json, tenant_id,
        metadata_json, lifecycle, content_hash,
        policy_evaluations_json, supersession_json,
        promoted_at, promoted_by_json, updated_at, version
      ) VALUES (
        @id, @candidate_id, @source, @content, @title, @category,
        @trust_level, @sensitivity, @author_json, @tenant_id,
        @metadata_json, @lifecycle, @content_hash,
        @policy_evaluations_json, @supersession_json,
        @promoted_at, @promoted_by_json, @updated_at, @version
      )
    `);

    this.stmtFindById = db.prepare(`
      SELECT * FROM curated_memories WHERE id = ?
    `);

    this.stmtFindByTenant = db.prepare(`
      SELECT * FROM curated_memories WHERE tenant_id = ?
    `);

    this.stmtFindByHash = db.prepare(`
      SELECT * FROM curated_memories WHERE content_hash = ? LIMIT 1
    `);

    // Tenant-scoped dedup lookups (B1, bead compile-then-govern-jfv.2.1). The
    // auto-govern sweep must NOT dedup across tenants — a global hash match would
    // let tenant A's candidate be silently suppressed as a "duplicate" of tenant
    // B's memory (a cross-tenant leak the API's promotion-service already guards
    // against). These mirror that tenant scoping.
    this.stmtFindByHashAndTenant = db.prepare(`
      SELECT * FROM curated_memories WHERE content_hash = ? AND tenant_id = ? LIMIT 1
    `);

    this.stmtTenantHashes = db.prepare(`
      SELECT content_hash FROM curated_memories WHERE tenant_id = ?
    `);

    this.stmtFindByLifecycle = db.prepare(`
      SELECT * FROM curated_memories WHERE lifecycle = ?
    `);

    this.stmtUpdateLifecycle = db.prepare(`
      UPDATE curated_memories SET lifecycle = @lifecycle, updated_at = @updated_at WHERE id = @id
    `);

    this.stmtUpdate = db.prepare(`
      UPDATE curated_memories SET
        candidate_id = @candidate_id,
        source = @source,
        content = @content,
        title = @title,
        category = @category,
        trust_level = @trust_level,
        sensitivity = @sensitivity,
        author_json = @author_json,
        tenant_id = @tenant_id,
        metadata_json = @metadata_json,
        lifecycle = @lifecycle,
        content_hash = @content_hash,
        policy_evaluations_json = @policy_evaluations_json,
        supersession_json = @supersession_json,
        promoted_at = @promoted_at,
        promoted_by_json = @promoted_by_json,
        updated_at = @updated_at,
        version = @version
      WHERE id = @id
    `);

    this.stmtCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM curated_memories
    `);

    this.stmtAllHashes = db.prepare(`
      SELECT content_hash FROM curated_memories
    `);

    this.stmtCountByLifecycle = db.prepare(`
      SELECT lifecycle, COUNT(*) as cnt FROM curated_memories GROUP BY lifecycle
    `);

    this.stmtCountByCategory = db.prepare(`
      SELECT category, COUNT(*) as cnt FROM curated_memories GROUP BY category
    `);

    this.stmtCountByTenant = db.prepare(`
      SELECT tenant_id, COUNT(*) as cnt FROM curated_memories GROUP BY tenant_id
    `);

    this.stmtFindStale = db.prepare(`
      SELECT * FROM curated_memories WHERE lifecycle = 'active' AND updated_at < ?
    `);

    this.stmtFindByTenantAndLifecycle = db.prepare(`
      SELECT * FROM curated_memories WHERE tenant_id = ? AND lifecycle = ?
    `);
  }

  /**
   * The underlying better-sqlite3 connection this repository was built on.
   *
   * Exposed read-only so a caller that writes across SEVERAL repositories on the
   * SAME connection — the curator's `promote()`, which touches curated_memories,
   * audit_events, and memory_links — can wrap all of those writes in ONE
   * transaction (all-or-nothing). Every repository constructed from a single
   * `createDatabase()` (as govern.ts / the daemon / the plugin do) shares this
   * exact handle, so a transaction opened here serializes every repo's writes on
   * the connection. Do not use it to bypass a repository's prepared statements —
   * it exists only to own a multi-repository transaction.
   */
  get connection(): Database.Database {
    return this.db;
  }

  /** Insert a new curated memory. */
  insert(memory: CuratedMemory): void {
    this.stmtInsert.run({
      id: memory.id,
      candidate_id: memory.candidateId,
      source: memory.source,
      content: memory.content,
      title: memory.title,
      category: memory.category,
      trust_level: memory.trustLevel,
      sensitivity: memory.sensitivity,
      author_json: JSON.stringify(memory.author),
      tenant_id: memory.tenantId,
      metadata_json: JSON.stringify(memory.metadata),
      lifecycle: memory.lifecycle,
      content_hash: memory.contentHash,
      policy_evaluations_json: JSON.stringify(memory.policyEvaluations),
      supersession_json:
        memory.supersession !== undefined ? JSON.stringify(memory.supersession) : null,
      promoted_at: memory.promotedAt,
      promoted_by_json: JSON.stringify(memory.promotedBy),
      updated_at: memory.updatedAt,
      version: memory.version,
    });
  }

  /** Find a memory by its primary key, or return null if not found. */
  findById(id: string): CuratedMemory | null {
    const row = this.stmtFindById.get(id);
    return row !== undefined ? rowToMemory(row) : null;
  }

  /** Return all curated memories belonging to the given tenant. */
  findByTenant(tenantId: string): CuratedMemory[] {
    const rows = this.stmtFindByTenant.all(tenantId);
    return rows.map(rowToMemory);
  }

  /**
   * Return the first memory with the given content hash, or null.
   * Useful for duplicate detection before promotion.
   */
  findByContentHash(hash: string): CuratedMemory | null {
    const row = this.stmtFindByHash.get(hash);
    return row !== undefined ? rowToMemory(row) : null;
  }

  /** Return all memories in the given lifecycle state. */
  findByLifecycle(lifecycle: MemoryLifecycleState): CuratedMemory[] {
    const rows = this.stmtFindByLifecycle.all(lifecycle);
    return rows.map(rowToMemory);
  }

  /**
   * Update only the lifecycle state and updatedAt timestamp.
   * Returns true if a row was modified, false if the id was not found.
   */
  updateLifecycle(id: string, lifecycle: MemoryLifecycleState, updatedAt: string): boolean {
    const result = this.stmtUpdateLifecycle.run({ id, lifecycle, updated_at: updatedAt });
    return result.changes > 0;
  }

  /**
   * Perform a full update of a curated memory record.
   * Returns true if a row was modified, false if the id was not found.
   */
  update(memory: CuratedMemory): boolean {
    const result = this.stmtUpdate.run({
      id: memory.id,
      candidate_id: memory.candidateId,
      source: memory.source,
      content: memory.content,
      title: memory.title,
      category: memory.category,
      trust_level: memory.trustLevel,
      sensitivity: memory.sensitivity,
      author_json: JSON.stringify(memory.author),
      tenant_id: memory.tenantId,
      metadata_json: JSON.stringify(memory.metadata),
      lifecycle: memory.lifecycle,
      content_hash: memory.contentHash,
      policy_evaluations_json: JSON.stringify(memory.policyEvaluations),
      supersession_json:
        memory.supersession !== undefined ? JSON.stringify(memory.supersession) : null,
      promoted_at: memory.promotedAt,
      promoted_by_json: JSON.stringify(memory.promotedBy),
      updated_at: memory.updatedAt,
      version: memory.version,
    });
    return result.changes > 0;
  }

  /** Return the total number of curated memories in the store. */
  count(): number {
    const result = this.stmtCount.get() as { cnt: number };
    return result.cnt;
  }

  /** Return all distinct content hashes present in the store. */
  getAllContentHashes(): string[] {
    const rows = this.stmtAllHashes.all() as Array<{ content_hash: string }>;
    return rows.map((r) => r.content_hash);
  }

  /**
   * Return the content hashes of the given tenant's memories only (B1). The
   * tenant-scoped counterpart to {@link getAllContentHashes}, used by the curator's
   * dedup so a batch/sweep never treats another tenant's memory as a duplicate.
   */
  getContentHashesByTenant(tenantId: string): string[] {
    const rows = this.stmtTenantHashes.all(tenantId) as Array<{ content_hash: string }>;
    return rows.map((r) => r.content_hash);
  }

  /**
   * Return the first memory in the given tenant with the given content hash, or
   * null (B1). The tenant-scoped counterpart to {@link findByContentHash}, so
   * exact-hash dedup never crosses the tenant boundary.
   */
  findByContentHashAndTenant(hash: string, tenantId: string): CuratedMemory | null {
    const row = this.stmtFindByHashAndTenant.get(hash, tenantId);
    return row !== undefined ? rowToMemory(row) : null;
  }

  /** Count memories grouped by lifecycle state */
  countByLifecycle(): Record<string, number> {
    const rows = this.stmtCountByLifecycle.all() as Array<{ lifecycle: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.lifecycle] = row.cnt;
    }
    return result;
  }

  /** Count memories grouped by category */
  countByCategory(): Record<string, number> {
    const rows = this.stmtCountByCategory.all() as Array<{ category: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.category] = row.cnt;
    }
    return result;
  }

  /** Count memories grouped by tenant */
  countByTenant(): Record<string, number> {
    const rows = this.stmtCountByTenant.all() as Array<{ tenant_id: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.tenant_id] = row.cnt;
    }
    return result;
  }

  /** Find active memories not updated since the given ISO date */
  findStale(olderThan: string): CuratedMemory[] {
    const rows = this.stmtFindStale.all(olderThan);
    return rows.map(rowToMemory);
  }

  /** Find memories by tenant and lifecycle state */
  findByTenantAndLifecycle(tenantId: string, lifecycle: MemoryLifecycleState): CuratedMemory[] {
    const rows = this.stmtFindByTenantAndLifecycle.all(tenantId, lifecycle);
    return rows.map(rowToMemory);
  }

  /**
   * Search active curated memories by text match on title and content.
   *
   * Uses FTS5 MATCH when the virtual table is available (faster, ranked).
   * Falls back to LIKE search with escaped wildcards when FTS5 is not present.
   * Results capped at 100 rows.
   */
  searchByText(query: string, tenantId?: string, categories?: string[]): CuratedMemory[] {
    if (this.hasFts5) {
      return this.searchByFts5(query, tenantId, categories);
    }
    return this.searchByLike(query, tenantId, categories);
  }

  /** FTS5-based search using MATCH for ranked full-text results */
  private searchByFts5(query: string, tenantId?: string, categories?: string[]): CuratedMemory[] {
    // Escape FTS5 special characters: " * ^ ( ) { } : -> NOT AND OR NEAR
    const ftsQuery = query.replace(/[*"^(){}:]/g, '').trim();
    if (ftsQuery.length === 0) return [];

    const conditions = ["cm.lifecycle = 'active'"];
    const params: Record<string, string> = { query: ftsQuery };

    appendOptionalFilters(conditions, params, tenantId, categories, 'cm.');

    const sql = `
      SELECT cm.* FROM curated_memories cm
      JOIN curated_memories_fts fts ON cm.rowid = fts.rowid
      WHERE curated_memories_fts MATCH @query
        AND ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT 100
    `;
    const rows = this.db.prepare(sql).all(params);
    return rows.map(rowToMemory);
  }

  /** LIKE-based fallback search with escaped wildcards */
  private searchByLike(query: string, tenantId?: string, categories?: string[]): CuratedMemory[] {
    const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
    const conditions = [
      "lifecycle = 'active'",
      "(title LIKE @pattern ESCAPE '\\' OR content LIKE @pattern ESCAPE '\\')",
    ];
    const params: Record<string, string> = { pattern: `%${escapedQuery}%` };

    appendOptionalFilters(conditions, params, tenantId, categories, '');

    const sql = `SELECT * FROM curated_memories WHERE ${conditions.join(' AND ')} LIMIT 100`;
    const rows = this.db.prepare(sql).all(params);
    return rows.map(rowToMemory);
  }
}
