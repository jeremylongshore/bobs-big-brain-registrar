import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { MemoryLinksRepository } from '../repositories/memory-links-repository.js';
import type { MemoryLink } from '../repositories/memory-links-repository.js';

const NOW = '2026-01-15T10:00:00.000Z';
const HASH = 'a'.repeat(64);

/** Insert a minimal curated memory row for FK satisfaction */
function insertMemory(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO curated_memories (
      id, candidate_id, source, content, title, category,
      trust_level, sensitivity, author_json, tenant_id,
      metadata_json, lifecycle, content_hash,
      policy_evaluations_json, promoted_at, promoted_by_json, updated_at, version
    ) VALUES (?, ?, 'manual', 'content', 'title', 'pattern', 'high', 'internal',
      '{"type":"ai","id":"c1"}', 'tenant-1', '{}', 'active', ?,
      '[]', ?, '{"type":"system","id":"s1"}', ?, 1)`,
  ).run(id, `cand-${id}`, HASH, NOW, NOW);
}

function makeLink(overrides?: Partial<MemoryLink>): MemoryLink {
  return {
    id: 'link-1',
    sourceMemoryId: 'm1',
    targetMemoryId: 'm2',
    linkType: 'relates_to',
    weight: 1.0,
    createdBy: 'test-user',
    source: 'manual',
    importBatchId: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('MemoryLinksRepository', () => {
  let db: Database.Database;
  let repo: MemoryLinksRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryLinksRepository(db);
    insertMemory(db, 'm1');
    insertMemory(db, 'm2');
    insertMemory(db, 'm3');
  });

  afterEach(() => {
    db.close();
  });

  it('inserts and retrieves a link by id', () => {
    const link = makeLink();
    repo.insert(link);
    const found = repo.findById('link-1');
    expect(found).not.toBeNull();
    expect(found!.sourceMemoryId).toBe('m1');
    expect(found!.targetMemoryId).toBe('m2');
    expect(found!.linkType).toBe('relates_to');
    expect(found!.weight).toBe(1.0);
  });

  it('returns null for non-existent id', () => {
    expect(repo.findById('nope')).toBeNull();
  });

  it('enforces unique constraint on (source, target, type)', () => {
    repo.insert(makeLink());
    expect(() => repo.insert(makeLink({ id: 'link-2' }))).toThrow();
  });

  it('allows same pair with different link types', () => {
    repo.insert(makeLink());
    repo.insert(makeLink({ id: 'link-2', linkType: 'supersedes' }));
    expect(repo.findBySource('m1')).toHaveLength(2);
  });

  it('findBySource returns outgoing links', () => {
    repo.insert(makeLink());
    repo.insert(makeLink({ id: 'link-2', sourceMemoryId: 'm1', targetMemoryId: 'm3' }));
    const links = repo.findBySource('m1');
    expect(links).toHaveLength(2);
  });

  it('findByTarget returns incoming links', () => {
    repo.insert(makeLink());
    const links = repo.findByTarget('m2');
    expect(links).toHaveLength(1);
    expect(links[0]!.sourceMemoryId).toBe('m1');
  });

  it('findByType filters by link type', () => {
    repo.insert(makeLink());
    repo.insert(
      makeLink({
        id: 'link-2',
        sourceMemoryId: 'm2',
        targetMemoryId: 'm3',
        linkType: 'supersedes',
      }),
    );
    expect(repo.findByType('relates_to')).toHaveLength(1);
    expect(repo.findByType('supersedes')).toHaveLength(1);
  });

  it('findByBatch filters by import batch', () => {
    repo.insert(makeLink({ importBatchId: 'batch-1' }));
    repo.insert(
      makeLink({
        id: 'link-2',
        sourceMemoryId: 'm2',
        targetMemoryId: 'm3',
        importBatchId: 'batch-1',
      }),
    );
    expect(repo.findByBatch('batch-1')).toHaveLength(2);
    expect(repo.findByBatch('batch-2')).toHaveLength(0);
  });

  it('delete removes a link', () => {
    repo.insert(makeLink());
    expect(repo.delete('link-1')).toBe(true);
    expect(repo.findById('link-1')).toBeNull();
  });

  it('delete returns false for non-existent id', () => {
    expect(repo.delete('nope')).toBe(false);
  });

  it('deleteByBatch removes all links for a batch', () => {
    repo.insert(makeLink({ importBatchId: 'batch-1' }));
    repo.insert(
      makeLink({
        id: 'link-2',
        sourceMemoryId: 'm2',
        targetMemoryId: 'm3',
        importBatchId: 'batch-1',
      }),
    );
    expect(repo.deleteByBatch('batch-1')).toBe(2);
    expect(repo.findByBatch('batch-1')).toHaveLength(0);
  });

  it('neighbors returns both directions', () => {
    repo.insert(makeLink()); // m1 → m2
    repo.insert(
      makeLink({
        id: 'link-2',
        sourceMemoryId: 'm3',
        targetMemoryId: 'm1',
        linkType: 'depends_on',
      }),
    ); // m3 → m1

    const neighbors = repo.neighbors('m1');
    expect(neighbors).toHaveLength(2);

    const outgoing = neighbors.find((n) => n.direction === 'outgoing');
    const incoming = neighbors.find((n) => n.direction === 'incoming');
    expect(outgoing!.memoryId).toBe('m2');
    expect(incoming!.memoryId).toBe('m3');
  });

  it('traverse returns reachable nodes via recursive CTE', () => {
    // m1 → m2 → m3 (chain of depth 2)
    repo.insert(makeLink()); // m1 → m2
    repo.insert(makeLink({ id: 'link-2', sourceMemoryId: 'm2', targetMemoryId: 'm3' })); // m2 → m3

    const nodes = repo.traverse('m1', 2);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.memoryId).toBe('m2');
    expect(nodes[0]!.depth).toBe(1);
    expect(nodes[1]!.memoryId).toBe('m3');
    expect(nodes[1]!.depth).toBe(2);
  });

  it('traverse respects maxDepth', () => {
    repo.insert(makeLink()); // m1 → m2
    repo.insert(makeLink({ id: 'link-2', sourceMemoryId: 'm2', targetMemoryId: 'm3' })); // m2 → m3

    const nodes = repo.traverse('m1', 1);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.memoryId).toBe('m2');
  });

  it('traverse returns empty for isolated node', () => {
    expect(repo.traverse('m3')).toHaveLength(0);
  });
});

describe('MemoryLinksRepository scoped reads', () => {
  let db: Database.Database;
  let repo: MemoryLinksRepository;
  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryLinksRepository(db);
    for (const id of ['root', 'bridge', 'leaf']) insertMemory(db, id);
    repo.insert(makeLink({ id: 'first', sourceMemoryId: 'root', targetMemoryId: 'bridge' }));
    repo.insert(makeLink({ id: 'second', sourceMemoryId: 'bridge', targetMemoryId: 'leaf' }));
  });
  afterEach(() => db.close());

  it.each([
    ['absent', {}, true],
    ['null', { audience: null }, true],
    ['tenant', { audience: 'tenant' }, true],
    ['admins', { audience: 'admins' }, false],
    ['owner', { audience: 'owner' }, false],
    ['unknown', { audience: 'future' }, false],
    ['array', { audience: ['tenant'] }, false],
    ['number', { audience: 0 }, false],
  ] as const)(
    'member traversal gates %s audience before expansion',
    (_label, metadata, visible) => {
      db.prepare('UPDATE curated_memories SET metadata_json = ? WHERE id = ?').run(
        JSON.stringify(metadata),
        'bridge',
      );
      const scope = { readerRole: 'member' as const, tenantId: 'tenant-1' };
      expect(repo.neighbors('root', scope).map((n) => n.memoryId)).toEqual(
        visible ? ['bridge'] : [],
      );
      expect(repo.traverse('root', 2, scope).map((n) => n.memoryId)).toEqual(
        visible ? ['bridge', 'leaf'] : [],
      );
    },
  );

  it('intersects the selected tenant with the allowlist, including explicit denial', () => {
    for (const scope of [
      { readerRole: 'owner' as const, allowedTenantIds: [] },
      { readerRole: 'owner' as const, allowedTenantIds: ['other'], tenantId: 'tenant-1' },
      { readerRole: 'owner' as const, allowedTenantIds: ['tenant-1'], tenantId: 'other' },
    ]) {
      expect(repo.neighbors('root', scope)).toEqual([]);
      expect(repo.traverse('root', 2, scope)).toEqual([]);
    }
  });
  it('reuses prepared scoped graph queries across reads', () => {
    const prepare = vi.spyOn(db, 'prepare');
    const scoped = new MemoryLinksRepository(db);
    const count = prepare.mock.calls.length;
    for (let i = 0; i < 2; i++) {
      scoped.neighbors('root', { readerRole: 'member' });
      scoped.traverse('root', 2, { readerRole: 'member' });
    }
    expect(prepare.mock.calls).toHaveLength(count);
    prepare.mockRestore();
  });

  it('uses root/edge and endpoint index lookups instead of scanning the whole graph', () => {
    const prepare = vi.spyOn(db, 'prepare');
    const scoped = new MemoryLinksRepository(db);
    scoped.neighbors('root', { readerRole: 'member' });
    scoped.traverse('root', 2, { readerRole: 'member' });
    const queries = prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes('@audiences'));
    prepare.mockRestore();
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      const parameters = {
        start: 'root',
        tenantId: null,
        allowedTenantIds: null,
        audiences: '["tenant"]',
        legacyVisible: 1,
        ...(query.includes('@maxDepth') ? { maxDepth: 2 } : {}),
      };
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(parameters) as Array<{
        detail: string;
      }>;
      const details = plan.map((row) => row.detail).join('\n');
      expect(details).not.toMatch(/SCAN (?:curated_memories|memory_links|ml\b|m\b)/);
      expect(details).toMatch(/SEARCH ml USING .*INDEX/);
    }
  });
});
