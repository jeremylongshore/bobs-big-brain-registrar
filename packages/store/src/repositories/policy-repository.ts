import { z } from 'zod';
import type Database from 'better-sqlite3';
import { GovernancePolicy } from '@qmd-team-intent-kb/schema';

/**
 * Zod schema for the raw SQLite row returned by better-sqlite3.
 * Validates the flat DB representation before domain parsing.
 */
const PolicyRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  tenant_id: z.string(),
  rules_json: z.string(),
  enabled: z.number(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Parse a raw SQLite row into a validated GovernancePolicy domain object.
 * Throws a descriptive error if the row fails validation.
 *
 * @param row - unknown value from better-sqlite3 .get()/.all()
 * @returns validated GovernancePolicy
 * @throws Error with row id and Zod issue details if parsing fails
 */
function rowToPolicy(row: unknown): GovernancePolicy {
  const flatResult = PolicyRowSchema.safeParse(row);
  if (!flatResult.success) {
    const issues = flatResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`governance_policies row failed flat validation: ${issues.join('; ')}`);
  }
  const flat = flatResult.data;

  let rules: unknown;
  try {
    rules = JSON.parse(flat.rules_json);
  } catch (e) {
    throw new Error(
      `governance_policies row id=${flat.id}: rules_json is not valid JSON: ${String(e)}`,
    );
  }

  const domainResult = GovernancePolicy.safeParse({
    id: flat.id,
    name: flat.name,
    tenantId: flat.tenant_id,
    rules,
    enabled: flat.enabled !== 0,
    version: flat.version,
    createdAt: flat.created_at,
    updatedAt: flat.updated_at,
  });

  if (!domainResult.success) {
    const issues = domainResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(
      `governance_policies row id=${flat.id} failed domain validation: ${issues.join('; ')}`,
    );
  }

  return domainResult.data;
}

/**
 * Repository for governance policy configurations.
 * All methods use prepared statements. Validation is the caller's responsibility.
 */
export class PolicyRepository {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtFindById: Database.Statement;
  private readonly stmtFindByTenant: Database.Statement;
  private readonly stmtList: Database.Statement;
  private readonly stmtUpdate: Database.Statement;
  private readonly stmtDelete: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtList = db.prepare('SELECT * FROM governance_policies');
    this.stmtInsert = db.prepare(`
      INSERT INTO governance_policies (
        id, name, tenant_id, rules_json, enabled, version, created_at, updated_at
      ) VALUES (
        @id, @name, @tenant_id, @rules_json, @enabled, @version, @created_at, @updated_at
      )
    `);

    this.stmtFindById = db.prepare(`
      SELECT * FROM governance_policies WHERE id = ?
    `);

    this.stmtFindByTenant = db.prepare(`
      SELECT * FROM governance_policies WHERE tenant_id = ?
    `);

    this.stmtUpdate = db.prepare(`
      UPDATE governance_policies SET
        name = @name,
        tenant_id = @tenant_id,
        rules_json = @rules_json,
        enabled = @enabled,
        version = @version,
        updated_at = @updated_at
      WHERE id = @id
    `);

    this.stmtDelete = db.prepare(`
      DELETE FROM governance_policies WHERE id = ?
    `);
  }

  /** Insert a new governance policy. */
  insert(policy: GovernancePolicy): void {
    this.stmtInsert.run({
      id: policy.id,
      name: policy.name,
      tenant_id: policy.tenantId,
      rules_json: JSON.stringify(policy.rules),
      enabled: policy.enabled ? 1 : 0,
      version: policy.version,
      created_at: policy.createdAt,
      updated_at: policy.updatedAt,
    });
  }

  /** Find a policy by its primary key, or return null if not found. */
  findById(id: string): GovernancePolicy | null {
    const row = this.stmtFindById.get(id);
    return row !== undefined ? rowToPolicy(row) : null;
  }

  /** Return all policies belonging to the given tenant. */
  findByTenant(tenantId: string): GovernancePolicy[] {
    const rows = this.stmtFindByTenant.all(tenantId);
    return rows.map(rowToPolicy);
  }

  /**
   * Return every policy across all tenants (5bm.10) — used by the health/status
   * dormancy check to find policies that leave registered rules unenforced.
   */
  list(): GovernancePolicy[] {
    return this.stmtList.all().map(rowToPolicy);
  }

  /**
   * Perform a full update of an existing policy record.
   * Returns true if a row was modified, false if the id was not found.
   */
  update(policy: GovernancePolicy): boolean {
    const result = this.stmtUpdate.run({
      id: policy.id,
      name: policy.name,
      tenant_id: policy.tenantId,
      rules_json: JSON.stringify(policy.rules),
      enabled: policy.enabled ? 1 : 0,
      version: policy.version,
      updated_at: policy.updatedAt,
    });
    return result.changes > 0;
  }

  /**
   * Delete a policy by id.
   * Returns true if a row was deleted, false if the id was not found.
   */
  delete(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
  }
}
