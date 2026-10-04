import { z } from 'zod';
import type Database from 'better-sqlite3';
import { MemoryCandidate, CandidateStatus } from '@qmd-team-intent-kb/schema';
import {
  assertDisclosureClean,
  computeContentHash,
  DisclosureRejectedError,
  scanDisclosureFields,
} from '@qmd-team-intent-kb/common';
import { assertEnumMembership } from './enum-membership.js';

/**
 * Thrown by {@link CandidateRepository.insert} when the incoming content is
 * byte-identical to text a governed redaction removed (K3). A subclass of
 * {@link DisclosureRejectedError}, so every write path that already handles a
 * disclosure rejection refuses it the same way. Carries no content.
 */
export class RedactedContentReingestError extends DisclosureRejectedError {
  constructor() {
    super('secret');
    this.name = 'RedactedContentReingestError';
    this.message =
      'Candidate rejected: this exact content was removed by a governed redaction and cannot re-enter the governed brain.';
  }
}

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
  /** Optional write-time provenance attestation (H1) — NULL on every pre-H1 row. */
  origin_json: z.string().nullable(),
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
  let origin: unknown;

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
  try {
    origin = flat.origin_json === null ? undefined : JSON.parse(flat.origin_json);
  } catch (e) {
    throw new Error(`candidates row id=${flat.id}: origin_json is not valid JSON: ${String(e)}`);
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
    origin,
  });

  if (!domainResult.success) {
    const issues = domainResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`candidates row id=${flat.id} failed domain validation: ${issues.join('; ')}`);
  }

  return domainResult.data;
}

/**
 * Skip-and-report variant of {@link rowToCandidate} for bulk reads that must not
 * be aborted by a single malformed row (B1, bead compile-then-govern-jfv.2.1).
 *
 * The nightly auto-govern sweep reads the ENTIRE inbox via {@link
 * CandidateRepository.findByStatus} and processes it. `rowToCandidate` THROWS on
 * any row that fails validation, so one corrupt/partial row (a truncated write, a
 * legacy row predating a schema field) would abort the whole sweep FOREVER — the
 * inbox could never drain. This wrapper contains that: a bad row is logged to
 * stderr (id + reason, never content) and dropped, so the sweep governs every good
 * row and the operator still sees the poison row surfaced. Returns null on failure.
 */
function rowToCandidateSafe(row: unknown): MemoryCandidate | null {
  try {
    return rowToCandidate(row);
  } catch (e) {
    const id =
      row !== null && typeof row === 'object' && 'id' in row
        ? String((row as { id: unknown }).id)
        : '<unknown>';
    process.stderr.write(
      `[candidate-repository] skipping unparseable candidate row id=${id}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
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
  private readonly stmtFindByStatus: Database.Statement;
  private readonly stmtFindByHash: Database.Statement;
  private readonly stmtFindByHashAndTenant: Database.Statement;
  private readonly stmtCount: Database.Statement;
  private readonly stmtCountByTenant: Database.Statement;
  private readonly stmtDeleteByBatch: Database.Statement;
  private readonly stmtUpdateStatus: Database.Statement;
  private readonly stmtUpdateContent: Database.Statement;
  private readonly stmtIdsByHashAndTenant: Database.Statement;
  private readonly stmtReadText: Database.Statement;
  private readonly stmtIsRedactedHash: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO candidates (
        id, status, source, content, title, category,
        trust_level, author_json, tenant_id,
        metadata_json, pre_policy_flags_json, content_hash, captured_at,
        import_batch_id, origin_json
      ) VALUES (
        @id, @status, @source, @content, @title, @category,
        @trust_level, @author_json, @tenant_id,
        @metadata_json, @pre_policy_flags_json, @content_hash, @captured_at,
        @import_batch_id, @origin_json
      )
    `);

    this.stmtFindById = db.prepare(`
      SELECT * FROM candidates WHERE id = ?
    `);

    this.stmtFindByTenant = db.prepare(`
      SELECT * FROM candidates WHERE tenant_id = ?
    `);

    // Tenant-scoped status lookup — the auto-govern sweep's drain query (B1).
    // Scoped by (status, tenant_id) so one tenant's sweep never reads another
    // tenant's candidates; backed by idx_candidates_status_tenant (migration 8).
    this.stmtFindByStatus = db.prepare(`
      SELECT * FROM candidates WHERE status = ? AND tenant_id = ?
    `);

    this.stmtFindByHash = db.prepare(`
      SELECT * FROM candidates WHERE content_hash = ? LIMIT 1
    `);

    // Tenant-scoped content-hash lookup — the idempotent-intake dedup (jfv.9). Scoped
    // by (content_hash, tenant_id) so one tenant's re-sent proposal is never deduped
    // against (nor can it read) another tenant's candidate.
    this.stmtFindByHashAndTenant = db.prepare(`
      SELECT * FROM candidates WHERE content_hash = ? AND tenant_id = ? LIMIT 1
    `);

    // Non-destructive terminal marker for a governed candidate (B1). The row is
    // NEVER deleted (candidates is Tier-A source of truth); the sweep only stamps
    // its outcome via this UPDATE. Tenant-scoped (id AND tenant_id) so a caller
    // holding a candidate UUID can never flip another tenant's row by id alone
    // (jfv.2.5(a) — closed as part of the agent-review approve surface, jfv.8).
    this.stmtUpdateStatus = db.prepare(`
      UPDATE candidates SET status = @status WHERE id = @id AND tenant_id = @tenantId
    `);

    // Governed redaction of a candidate's stored copy (K3). The ONLY statement
    // that rewrites candidate content; tenant-scoped like updateStatus.
    this.stmtUpdateContent = db.prepare(`
      UPDATE candidates SET content = @content, title = @title, content_hash = @contentHash
      WHERE id = @id AND tenant_id = @tenantId
    `);

    this.stmtReadText = db.prepare(`
      SELECT content, title FROM candidates WHERE id = ? AND tenant_id = ?
    `);

    this.stmtIdsByHashAndTenant = db.prepare(`
      SELECT id FROM candidates WHERE content_hash = ? AND tenant_id = ?
    `);

    // True when a governed-redaction receipt (K3) records this hash as the
    // PRE-redaction hash of a row in this tenant: the removed text coming back.
    this.stmtIsRedactedHash = db.prepare(`
      SELECT 1 FROM audit_events
      WHERE action = 'redacted' AND tenant_id = ?
        AND json_extract(details_json, '$.oldContentHash') = ?
      LIMIT 1
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
   * **Enum-membership re-assertion (Epic 0 residual hardening).** The disclosure
   * scan deliberately SKIPS the closed-vocabulary fields (`status`, `source`,
   * `category`, `trustLevel`, `confidence`, `sensitivity`, `author.type`) - safe
   * only while those fields actually hold a vocabulary member. A raw `insert()`
   * caller that bypassed `MemoryCandidate.parse()` could otherwise smuggle an
   * SSN / comp / secret-shaped value into an enum field and ride the skip into
   * durable state. `assertEnumMembership` closes that gap here: an off-vocabulary
   * value is rejected (routed through the disclosure scan first so a
   * disclosure-shaped value is caught with its precise category); a valid enum
   * value is left untouched.
   *
   * @throws {DisclosureRejectedError} when content/title/tags contain disallowed
   *   PII, compensation, or credential/secret material - or when a disclosure-shaped
   *   value is smuggled into an enum-constrained field.
   * @throws {EnumConstraintViolationError} when an enum-constrained field carries a
   *   non-vocabulary value that is not itself disclosure-shaped.
   * @throws {RedactedContentReingestError} when the content is byte-identical to
   *   text a governed redaction removed from this tenant (K3) — a redaction
   *   changes the stored hash, so without this the original could be re-ingested.
   */
  insert(candidate: MemoryCandidate, contentHash: string, importBatchId?: string): void {
    // Choke-point enforcement: reject before the row is ever written.
    assertDisclosureClean(candidate);
    // Re-assert closed-vocabulary membership so a raw caller cannot smuggle
    // disclosure content through a field the disclosure scan skips by name.
    assertEnumMembership(candidate);
    // Redacted text must not come back (K3). Hash the content itself rather than
    // trusting the caller-supplied `contentHash`.
    if (this.isRedactedContent(candidate.content, candidate.tenantId)) {
      throw new RedactedContentReingestError();
    }
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
      origin_json: candidate.origin !== undefined ? JSON.stringify(candidate.origin) : null,
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
   * Return every candidate in the given `status`, scoped to `tenantId` (B1, bead
   * compile-then-govern-jfv.2.1). The auto-govern sweep calls
   * `findByStatus('inbox', config.tenantId)` to drain the pre-governance inbox.
   *
   * TOLERANT read: a row that fails validation is skipped and reported to stderr
   * (via {@link rowToCandidateSafe}) rather than thrown, so a single malformed
   * candidate can never abort the whole sweep — the inbox always drains. Tenant
   * scoping is mandatory (not optional) so a sweep can never read across the
   * tenant boundary.
   */
  findByStatus(status: CandidateStatus, tenantId: string): MemoryCandidate[] {
    const rows = this.stmtFindByStatus.all(status, tenantId);
    const out: MemoryCandidate[] = [];
    for (const row of rows) {
      const c = rowToCandidateSafe(row);
      if (c !== null) out.push(c);
    }
    return out;
  }

  /**
   * Stamp a candidate's terminal status IN PLACE (B1) — the non-destructive
   * retirement primitive the sweep uses instead of DELETE. `candidates` is
   * insert-only Tier-A source of truth, so a governed candidate LEAVES the inbox
   * by changing its status marker, never by deletion (which would destroy the only
   * copy of a remote teammate's proposal + the human review queue).
   *
   * Validates `status` against the closed {@link CandidateStatus} vocabulary before
   * writing (a raw UPDATE otherwise bypasses the enum-membership backstop that
   * `insert()` enforces). Scoped to `tenantId` so the primitive cannot flip a row
   * outside the caller's tenant. Returns the number of rows changed (0 if no row
   * matches `id` AND `tenantId`).
   *
   * @throws {z.ZodError} if `status` is not a valid CandidateStatus value.
   */
  updateStatus(id: string, status: CandidateStatus, tenantId: string): number {
    const validated = CandidateStatus.parse(status);
    return this.stmtUpdateStatus.run({ id, status: validated, tenantId }).changes;
  }

  /**
   * True when `content` is byte-identical to text a governed redaction removed
   * from this tenant (K3): its SHA-256 equals the `oldContentHash` of a
   * `redacted` receipt. Compares hashes only; the removed text is not stored.
   */
  isRedactedContent(content: string, tenantId: string): boolean {
    return this.stmtIsRedactedHash.get(tenantId, computeContentHash(content)) !== undefined;
  }

  /** Ids of every candidate in the tenant whose stored content hash is `hash` (K3). */
  findIdsByContentHashAndTenant(hash: string, tenantId: string): string[] {
    const rows = this.stmtIdsByHashAndTenant.all(hash, tenantId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /**
   * Read a candidate's stored content and title WITHOUT domain validation (K3).
   * Governed redaction must be able to reach a legacy row that no longer parses
   * as a `MemoryCandidate` — that row can still hold the text being removed.
   * Tenant-scoped; null when no row matches `id` AND `tenantId`.
   */
  readStoredText(id: string, tenantId: string): { content: string; title: string } | null {
    const row = this.stmtReadText.get(id, tenantId) as
      { content: string; title: string } | undefined;
    return row ?? null;
  }

  /**
   * Replace a candidate's stored content and title IN PLACE (K3 governed
   * redaction) and recompute its content hash. `candidates` is otherwise
   * insert-only; this is the single content-rewriting statement and exists so a
   * redaction of a promoted memory also removes the text from the candidate row
   * it was promoted from. The caller writes the `redacted` receipt in the same
   * transaction.
   *
   * The replacement text goes through the same disclosure scan as an insert, so
   * a redaction cannot itself write disallowed material. It does not require the
   * existing row to parse (see {@link readStoredText}). Tenant-scoped. Returns
   * the new content hash, or null when no row matches `id` AND `tenantId`.
   *
   * @throws {DisclosureRejectedError} when the replacement fails the disclosure gate.
   */
  updateContent(
    id: string,
    tenantId: string,
    replacement: { content: string; title: string },
  ): string | null {
    const violation = scanDisclosureFields([replacement.content, replacement.title]);
    if (violation !== null) throw new DisclosureRejectedError(violation.category);
    const contentHash = computeContentHash(replacement.content);
    const changes = this.stmtUpdateContent.run({
      id,
      tenantId,
      content: replacement.content,
      title: replacement.title,
      contentHash,
    }).changes;
    return changes > 0 ? contentHash : null;
  }

  /**
   * Return the first candidate with the given content hash, or null.
   * Useful for duplicate detection before insertion.
   */
  findByContentHash(hash: string): MemoryCandidate | null {
    const row = this.stmtFindByHash.get(hash);
    return row !== undefined ? rowToCandidate(row) : null;
  }

  /**
   * Return the first candidate with the given content hash FOR A TENANT, or null —
   * the tenant-scoped dedup the idempotent intake path uses (jfv.9). Prefer this
   * over {@link findByContentHash} on any per-tenant write path: the unscoped
   * variant can return another tenant's row.
   */
  findByContentHashAndTenant(hash: string, tenantId: string): MemoryCandidate | null {
    const row = this.stmtFindByHashAndTenant.get(hash, tenantId);
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
