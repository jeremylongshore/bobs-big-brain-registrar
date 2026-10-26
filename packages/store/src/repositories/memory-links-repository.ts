import type Database from 'better-sqlite3';
import { AUDIENCE_RANK, isAudienceVisibleToRole } from '@qmd-team-intent-kb/common';
import type { ReaderRole } from '@qmd-team-intent-kb/common';
import type { LinkType, LinkSource } from '@qmd-team-intent-kb/schema';

/** Read constraints applied to both endpoints before graph expansion. */
export interface GraphReadScope {
  tenantId?: string;
  allowedTenantIds?: readonly string[];
  readerRole: ReaderRole;
}

/** Domain representation of a memory link */
export interface MemoryLink {
  id: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  linkType: LinkType;
  weight: number;
  createdBy: string;
  source: LinkSource;
  importBatchId: string | null;
  createdAt: string;
}

/** A neighbor node returned by graph traversal */
export interface Neighbor {
  memoryId: string;
  linkType: LinkType;
  weight: number;
  direction: 'outgoing' | 'incoming';
}

/** A node in a graph traversal result */
export interface GraphNode {
  memoryId: string;
  depth: number;
  linkType: LinkType;
  weight: number;
}

/**
 * Repository for memory-to-memory links (knowledge graph edges).
 * Supports CRUD, neighbor queries, and recursive CTE graph traversal.
 */
export class MemoryLinksRepository {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtFindById: Database.Statement;
  private readonly stmtFindBySource: Database.Statement;
  private readonly stmtFindByTarget: Database.Statement;
  private readonly stmtFindByType: Database.Statement;
  private readonly stmtFindByBatch: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtDeleteByBatch: Database.Statement;
  private readonly stmtNeighbors: Database.Statement;
  private readonly stmtScopedNeighbors: Database.Statement;
  private readonly stmtTraverse: Database.Statement;
  private readonly stmtScopedTraverse: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO memory_links (
        id, source_memory_id, target_memory_id, link_type,
        weight, created_by, source, import_batch_id, created_at
      ) VALUES (
        @id, @source_memory_id, @target_memory_id, @link_type,
        @weight, @created_by, @source, @import_batch_id, @created_at
      )
    `);

    this.stmtFindById = db.prepare(`
      SELECT * FROM memory_links WHERE id = ?
    `);

    this.stmtFindBySource = db.prepare(`
      SELECT * FROM memory_links WHERE source_memory_id = ? ORDER BY created_at ASC
    `);

    this.stmtFindByTarget = db.prepare(`
      SELECT * FROM memory_links WHERE target_memory_id = ? ORDER BY created_at ASC
    `);

    this.stmtFindByType = db.prepare(`
      SELECT * FROM memory_links WHERE link_type = ? ORDER BY created_at ASC
    `);

    this.stmtFindByBatch = db.prepare(`
      SELECT * FROM memory_links WHERE import_batch_id = ? ORDER BY created_at ASC
    `);

    this.stmtDelete = db.prepare(`
      DELETE FROM memory_links WHERE id = ?
    `);

    this.stmtDeleteByBatch = db.prepare(`
      DELETE FROM memory_links WHERE import_batch_id = ?
    `);

    this.stmtNeighbors = db.prepare(`
      SELECT target_memory_id AS memoryId, link_type AS linkType, weight, 'outgoing' AS direction
        FROM memory_links WHERE source_memory_id = ?
      UNION ALL
      SELECT source_memory_id AS memoryId, link_type AS linkType, weight, 'incoming' AS direction
        FROM memory_links WHERE target_memory_id = ?
      ORDER BY weight DESC
    `);
    this.stmtScopedNeighbors = db.prepare(`
      SELECT ml.target_memory_id AS memoryId, ml.link_type AS linkType, ml.weight, 'outgoing' AS direction
        FROM memory_links ml WHERE ml.source_memory_id = @start AND ${READABLE_ENDPOINTS_SQL}
      UNION ALL
      SELECT ml.source_memory_id AS memoryId, ml.link_type AS linkType, ml.weight, 'incoming' AS direction
        FROM memory_links ml WHERE ml.target_memory_id = @start AND ${READABLE_ENDPOINTS_SQL}
      ORDER BY weight DESC
    `);
    this.stmtTraverse = db.prepare(traversalSql(false));
    this.stmtScopedTraverse = db.prepare(traversalSql(true));
  }

  /** Insert a new link. Throws on unique constraint violation. */
  insert(link: MemoryLink): void {
    this.stmtInsert.run({
      id: link.id,
      source_memory_id: link.sourceMemoryId,
      target_memory_id: link.targetMemoryId,
      link_type: link.linkType,
      weight: link.weight,
      created_by: link.createdBy,
      source: link.source,
      import_batch_id: link.importBatchId,
      created_at: link.createdAt,
    });
  }

  /** Find a link by its primary key, or return null. */
  findById(id: string): MemoryLink | null {
    const row = this.stmtFindById.get(id) as RawLinkRow | undefined;
    return row !== undefined ? rowToLink(row) : null;
  }

  /** All links originating from a given memory. */
  findBySource(memoryId: string): MemoryLink[] {
    return (this.stmtFindBySource.all(memoryId) as RawLinkRow[]).map(rowToLink);
  }

  /** All links pointing to a given memory. */
  findByTarget(memoryId: string): MemoryLink[] {
    return (this.stmtFindByTarget.all(memoryId) as RawLinkRow[]).map(rowToLink);
  }

  /** All links of a given type. */
  findByType(linkType: LinkType): MemoryLink[] {
    return (this.stmtFindByType.all(linkType) as RawLinkRow[]).map(rowToLink);
  }

  /** All links associated with a given import batch. */
  findByBatch(batchId: string): MemoryLink[] {
    return (this.stmtFindByBatch.all(batchId) as RawLinkRow[]).map(rowToLink);
  }

  /** Delete a link by id. Returns true if a row was removed. */
  delete(id: string): boolean {
    return this.stmtDelete.run(id).changes > 0;
  }

  /** Delete all links associated with an import batch. Returns count deleted. */
  deleteByBatch(batchId: string): number {
    return this.stmtDeleteByBatch.run(batchId).changes;
  }

  /** Get all neighbors (both directions) of a memory. */
  neighbors(memoryId: string, scope?: GraphReadScope): Neighbor[] {
    if (scope === undefined) return this.stmtNeighbors.all(memoryId, memoryId) as Neighbor[];
    return this.stmtScopedNeighbors.all({
      start: memoryId,
      ...scopeParameters(scope),
    }) as Neighbor[];
  }

  /**
   * Recursive CTE graph traversal from a starting memory.
   * Returns all reachable nodes up to the given depth.
   */
  traverse(memoryId: string, maxDepth: number = 2, scope?: GraphReadScope): GraphNode[] {
    const stmt = scope === undefined ? this.stmtTraverse : this.stmtScopedTraverse;
    return stmt.all({
      start: memoryId,
      maxDepth,
      ...(scope === undefined ? {} : scopeParameters(scope)),
    }) as GraphNode[];
  }
}

/** Raw row shape from SQLite */
interface RawLinkRow {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  link_type: string;
  weight: number;
  created_by: string;
  source: string;
  import_batch_id: string | null;
  created_at: string;
}

function rowToLink(row: RawLinkRow): MemoryLink {
  return {
    id: row.id,
    sourceMemoryId: row.source_memory_id,
    targetMemoryId: row.target_memory_id,
    linkType: row.link_type as LinkType,
    weight: row.weight,
    createdBy: row.created_by,
    source: row.source as LinkSource,
    importBatchId: row.import_batch_id,
    createdAt: row.created_at,
  };
}

// Root and traversal edges use their indexes; each endpoint is checked by ID.
// Never materialize the entire readable graph or expand through a hidden bridge.
// Column names below are fixed internal constants, never caller-provided SQL.
const READABLE_ENDPOINTS_SQL = ['source_memory_id', 'target_memory_id']
  .map(
    (column) => `
  EXISTS (
    SELECT 1 FROM curated_memories m
    WHERE m.id = ml.${column}
      AND (@tenantId IS NULL OR m.tenant_id = @tenantId)
      AND (@allowedTenantIds IS NULL OR m.tenant_id IN (SELECT value FROM json_each(@allowedTenantIds)))
      AND (
        (json_extract(m.metadata_json, '$.audience') IS NULL AND @legacyVisible = 1)
        OR (
          json_type(m.metadata_json, '$.audience') = 'text'
          AND json_extract(m.metadata_json, '$.audience') IN (SELECT value FROM json_each(@audiences))
        )
      )
  )
`,
  )
  .join(' AND ');

function traversalSql(scoped: boolean): string {
  const readable = scoped ? `AND ${READABLE_ENDPOINTS_SQL}` : '';
  return `
    WITH RECURSIVE graph(memoryId, depth, linkType, weight) AS (
      SELECT ml.target_memory_id, 1, ml.link_type, ml.weight
        FROM memory_links ml WHERE ml.source_memory_id = @start ${readable}
      UNION ALL
      SELECT ml.target_memory_id, g.depth + 1, ml.link_type, ml.weight
        FROM memory_links ml
        JOIN graph g ON ml.source_memory_id = g.memoryId
        WHERE g.depth < @maxDepth ${readable}
    ),
    ranked_paths AS (
      SELECT *, ROW_NUMBER() OVER(PARTITION BY memoryId ORDER BY depth ASC, weight DESC) AS rn
        FROM graph WHERE memoryId != @start
    )
    SELECT memoryId, depth, linkType, weight FROM ranked_paths
      WHERE rn = 1 ORDER BY depth ASC, weight DESC
  `;
}

function scopeParameters(scope: GraphReadScope) {
  return {
    tenantId: scope.tenantId ?? null,
    allowedTenantIds:
      scope.allowedTenantIds === undefined ? null : JSON.stringify(scope.allowedTenantIds),
    audiences: JSON.stringify(
      Object.keys(AUDIENCE_RANK).filter((audience) =>
        isAudienceVisibleToRole(audience, scope.readerRole),
      ),
    ),
    legacyVisible: Number(isAudienceVisibleToRole(undefined, scope.readerRole)),
  };
}
