import { z } from 'zod';
import type Database from 'better-sqlite3';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { assertDisclosureClean } from '@qmd-team-intent-kb/common';

/**
 * Zod schema for the raw SQLite row returned by better-sqlite3.
 * Validates the flat DB representation before domain parsing.
 */
const CandidateRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  source: z.string(),
  content: z.string(),
  title: z.string(),
  category: z.string(),
  trust_level: z.string(),
  author_json: z.string(),
  tenant_id: z.string(),
  metadata_json: z.string(),
  pre_policy_flags_json: z.string(),
  content_hash: z.string(),
  captured_at: z.string(),
  created_at: z.string(),
});

/**
 * Parse a raw SQLite row into a validated MemoryCandidate domain object.
 * Throws a descriptive error if the row fails validation.
 *
 * @param row - unknown value from better-sqlite3 .get()/.all()
 * @returns validated MemoryCandidate
 * @throws Error with row id and Zod issue details if parsing fails
 */
function rowToCandidate(row: unknown): MemoryCandidate {
  const flatResult = CandidateRowSchema.safeParse(row);
  if (!flatResult.success) {
    const issues = flatResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`candidates row failed flat validation: ${issues.join('; ')}`);
  }
  const flat = flatResult.data;

  let author: unknown;
  let metadata: unknown;
  let prePolicyFlags: unknown;

  try {
    author = JSON.parse(flat.author_json);
  } catch (e) {
    throw new Error(`candidates row id=${flat.id}: author_json is not valid JSON: ${String(e)}`);
  }
  try {
    metadata = JSON.parse(flat.metadata_json);
  } catch (e) {
    throw new Error(`candidates row id=${flat.id}: metadata_json is not valid JSON: ${String(e)}`);
  }
  try {
    prePolicyFlags = JSON.parse(flat.pre_policy_flags_json);
  } catch (e) {
    throw new Error(
      `candidates row id=${flat.id}: pre_policy_flags_json is not valid JSON: ${String(e)}`,
    );
  }

  const domainResult = MemoryCandidate.safeParse({
    id: flat.id,
    status: flat.status,
    source: flat.source,
    content: flat.content,
    title: flat.title,
    category: flat.category,
    trustLevel: flat.trust_level,
    author,
    tenantId: flat.tenant_id,
    metadata,
    prePolicyFlags,
    capturedAt: flat.captured_at,
  });

  if (!domainResult.success) {
    const issues = domainResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`candidates row id=${flat.id} failed domain validation: ${issues.join('; ')}`);
  }

  return domainResult.data;
}

/**
 * Repository for raw memory candidate proposals.
 * All methods use prepared statements for safety and performance.
 * Validation is the responsibility of the caller.
 */
export class CandidateRepository {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtFindById: Database.Statement;
  private readonly stmtFindByTenant: Database.Statement;
  private readonly stmtFindByHash: Database.Statement;
  private readonly stmtCount: Database.Statement;
  private readonly stmtCountByTenant: Database.Statement;
  private readonly stmtDeleteByBatch: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO candidates (
        id, status, source, content, title, category,
        trust_level, author_json, tenant_id,
        metadata_json, pre_policy_flags_json, content_hash, captured_at,
        import_batch_id
      ) VALUES (
        @id, @status, @source, @content, @title, @category,
        @trust_level, @author_json, @tenant_id,
        @metadata_json, @pre_policy_flags_json, @content_hash, @captured_at,
        @import_batch_id
      )
    `);

    this.stmtFindById = db.prepare(`
      SELECT * FROM candidates WHERE id = ?
    `);

    this.stmtFindByTenant = db.prepare(`
      SELECT * FROM candidates WHERE tenant_id = ?
    `);

    this.stmtFindByHash = db.prepare(`
      SELECT * FROM candidates WHERE content_hash = ? LIMIT 1
    `);

    this.stmtCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM candidates
    `);

    this.stmtCountByTenant = db.prepare(`
      SELECT tenant_id, COUNT(*) as cnt FROM candidates GROUP BY tenant_id
    `);

    this.stmtDeleteByBatch = db.prepare(`
      DELETE FROM candidates WHERE import_batch_id = ?
    `);
  }

  /**
   * Insert a new candidate. The contentHash must be provided by the caller.
   *
   * **Disclosure / secret choke point (Epic 0, compile-then-govern-c5k).** Every
   * candidate write path in the system funnels through this single SQL INSERT —
   * API intake, curator bulk-import, spool-intake / ICO ingest, MCP propose→spool,
   * and promotion re-scan. Enforcing the PII / comp-secret / credential gate here
   * (rather than only in the API service layer, which three paths bypassed) means
   * no caller can write disallowed material regardless of how it arrived.
   *
   * The scan normalizes (NFKC + invisible-strip + homoglyph-fold + decode-once)
   * before matching, is ReDoS-safe, fails closed, and never logs the matched
   * value. A violating candidate throws `DisclosureRejectedError` and is never
   * written.
   *
   * @throws {DisclosureRejectedError} when content/title/tags contain disallowed
   *   PII, compensation, or credential/secret material.
   */
  insert(candidate: MemoryCandidate, contentHash: string, importBatchId?: string): void {
    // Choke-point enforcement: reject before the row is ever written.
    assertDisclosureClean(candidate);
    this.stmtInsert.run({
      id: candidate.id,
      status: candidate.status,
      source: candidate.source,
      content: candidate.content,
      title: candidate.title,
      category: candidate.category,
      trust_level: candidate.trustLevel,
      author_json: JSON.stringify(candidate.author),
      tenant_id: candidate.tenantId,
      metadata_json: JSON.stringify(candidate.metadata),
      pre_policy_flags_json: JSON.stringify(candidate.prePolicyFlags),
      content_hash: contentHash,
      captured_at: candidate.capturedAt,
      import_batch_id: importBatchId ?? null,
    });
  }

  /** Find a candidate by its primary key, or return null if not found. */
  findById(id: string): MemoryCandidate | null {
    const row = this.stmtFindById.get(id);
    return row !== undefined ? rowToCandidate(row) : null;
  }

  /** Return all candidates belonging to the given tenant. */
  findByTenant(tenantId: string): MemoryCandidate[] {
    const rows = this.stmtFindByTenant.all(tenantId);
    return rows.map(rowToCandidate);
  }

  /**
   * Return the first candidate with the given content hash, or null.
   * Useful for duplicate detection before insertion.
   */
  findByContentHash(hash: string): MemoryCandidate | null {
    const row = this.stmtFindByHash.get(hash);
    return row !== undefined ? rowToCandidate(row) : null;
  }

  /** Return the total number of candidates in the store. */
  count(): number {
    const result = this.stmtCount.get() as { cnt: number };
    return result.cnt;
  }

  /** Delete all candidates associated with an import batch. Returns count deleted. */
  deleteByBatch(batchId: string): number {
    return this.stmtDeleteByBatch.run(batchId).changes;
  }

  /** Count candidates grouped by tenant */
  countByTenant(): Record<string, number> {
    const rows = this.stmtCountByTenant.all() as Array<{ tenant_id: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.tenant_id] = row.cnt;
    }
    return result;
  }
}
