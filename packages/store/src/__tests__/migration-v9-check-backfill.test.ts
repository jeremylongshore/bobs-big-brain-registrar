/**
 * Migration v9 — enum CHECK-constraint backfill (bead qmd-team-intent-kb-5bm.9).
 *
 * New DBs get the CHECK constraints from CURATED_MEMORIES_DDL, so v9 is a no-op
 * for them (covered implicitly by the whole suite still passing). These tests
 * exercise the REAL path: a LEGACY `curated_memories` table with NO CHECK
 * constraints (the shape of a pre-5bm.1 live DB), rebuilt in place on the next
 * `createDatabase`. We assert the constraints land, every row + rowid survives,
 * the external-content FTS index still resolves, the memory_links foreign key
 * stays intact, and a row that violates the new constraints aborts the whole
 * migration (fail-closed) rather than silently dropping data.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from '../database.js';

/** The pre-5bm.1 `curated_memories` DDL: identical columns, NO CHECK clauses. */
const LEGACY_CURATED_MEMORIES = `
CREATE TABLE curated_memories (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  author_json TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  lifecycle TEXT NOT NULL DEFAULT 'active',
  content_hash TEXT NOT NULL,
  policy_evaluations_json TEXT NOT NULL DEFAULT '[]',
  supersession_json TEXT,
  promoted_at TEXT NOT NULL,
  promoted_by_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE VIRTUAL TABLE curated_memories_fts USING fts5(
  title, content, content='curated_memories', content_rowid='rowid'
);
CREATE TRIGGER curated_memories_fts_insert AFTER INSERT ON curated_memories BEGIN
  INSERT INTO curated_memories_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER curated_memories_fts_delete AFTER DELETE ON curated_memories BEGIN
  INSERT INTO curated_memories_fts(curated_memories_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER curated_memories_fts_update AFTER UPDATE ON curated_memories BEGIN
  INSERT INTO curated_memories_fts(curated_memories_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO curated_memories_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  source_memory_id TEXT NOT NULL REFERENCES curated_memories(id),
  target_memory_id TEXT NOT NULL REFERENCES curated_memories(id),
  link_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_by TEXT NOT NULL,
  source TEXT NOT NULL,
  import_batch_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_memory_id, target_memory_id, link_type)
);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function insertLegacyMemory(
  db: Database.Database,
  id: string,
  overrides: Record<string, string> = {},
): void {
  const row = {
    id,
    candidate_id: `cand-${id}`,
    source: 'import',
    content: `content for ${id}`,
    title: `title ${id}`,
    category: 'reference',
    trust_level: 'medium',
    sensitivity: 'internal',
    author_json: '{"type":"system","id":"legacy"}',
    tenant_id: 'default',
    lifecycle: 'active',
    content_hash: id.repeat(4).slice(0, 64).padEnd(64, '0'),
    promoted_at: '2026-01-01T00:00:00.000Z',
    promoted_by_json: '{"type":"system","id":"curator"}',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO curated_memories
       (id, candidate_id, source, content, title, category, trust_level, sensitivity,
        author_json, tenant_id, lifecycle, content_hash, promoted_at, promoted_by_json, updated_at)
     VALUES
       (@id, @candidate_id, @source, @content, @title, @category, @trust_level, @sensitivity,
        @author_json, @tenant_id, @lifecycle, @content_hash, @promoted_at, @promoted_by_json, @updated_at)`,
  ).run(row);
}

/** Build a legacy (pre-CHECK, migrations@8) DB file and return its path. */
function buildLegacyDb(dir: string, seed: (db: Database.Database) => void): string {
  const dbPath = join(dir, 'legacy.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(LEGACY_CURATED_MEMORIES);
  for (let v = 1; v <= 8; v++) {
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(v, `legacy-${v}`);
  }
  seed(db);
  db.close();
  return dbPath;
}

describe('migration v9 — CHECK backfill on a legacy table (5bm.9)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('adds CHECK constraints, preserves every row + rowid, keeps FTS and FKs intact', () => {
    dir = mkdtempSync(join(tmpdir(), 'v9-legacy-'));
    const dbPath = buildLegacyDb(dir, (db) => {
      insertLegacyMemory(db, 'aaaaaaaa', { category: 'decision', title: 'alpha widget' });
      insertLegacyMemory(db, 'bbbbbbbb', { category: 'pattern', title: 'beta gadget' });
      db.prepare(
        `INSERT INTO memory_links (id, source_memory_id, target_memory_id, link_type, created_by, source)
         VALUES ('lnk1', 'aaaaaaaa', 'bbbbbbbb', 'related', 'system', 'import')`,
      ).run();
    });

    // Sanity: the legacy table has NO check and is at version 8.
    const pre = new Database(dbPath, { readonly: true });
    expect(
      (
        pre.prepare("SELECT sql FROM sqlite_schema WHERE name='curated_memories'").get() as {
          sql: string;
        }
      ).sql,
    ).not.toMatch(/CHECK/i);
    pre.close();

    // Reopening through createDatabase runs migrations → v9 rebuild.
    const db = createDatabase({ path: dbPath });
    try {
      // 1. CHECK constraints now present.
      const ddl = (
        db.prepare("SELECT sql FROM sqlite_schema WHERE name='curated_memories'").get() as {
          sql: string;
        }
      ).sql;
      expect(ddl).toMatch(/CHECK\s*\(\s*category\s+IN/i);
      expect(ddl).toMatch(/CHECK\s*\(\s*sensitivity\s+IN/i);

      // 2. Every row + its rowid preserved.
      const rows = db
        .prepare('SELECT rowid, id, category FROM curated_memories ORDER BY rowid')
        .all() as Array<{ rowid: number; id: string; category: string }>;
      expect(rows.map((r) => r.id)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
      expect(rows[0]!.rowid).toBe(1);
      expect(rows[1]!.rowid).toBe(2);

      // 3. External-content FTS still resolves by the preserved rowids.
      const fts = db
        .prepare(
          "SELECT c.id FROM curated_memories_fts f JOIN curated_memories c ON c.rowid = f.rowid WHERE curated_memories_fts MATCH 'gadget'",
        )
        .all() as Array<{ id: string }>;
      expect(fts.map((r) => r.id)).toEqual(['bbbbbbbb']);

      // 4. memory_links FK row survives and referential integrity is clean.
      expect((db.prepare('SELECT COUNT(*) AS n FROM memory_links').get() as { n: number }).n).toBe(
        1,
      );
      expect((db.pragma('foreign_key_check') as unknown[]).length).toBe(0);

      // 5. The new constraint actually rejects a bad write now.
      expect(() =>
        db
          .prepare(
            "INSERT INTO curated_memories (id, candidate_id, source, content, title, category, trust_level, sensitivity, author_json, tenant_id, content_hash, promoted_at, promoted_by_json, updated_at) VALUES ('x','c','import','y','z','not-a-category','medium','internal','{}','t','h','p','{}','u')",
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('fails closed (rolls back, keeps CHECK off) if a legacy row violates the new constraints', () => {
    dir = mkdtempSync(join(tmpdir(), 'v9-bad-'));
    const dbPath = buildLegacyDb(dir, (db) => {
      insertLegacyMemory(db, 'good1111', { category: 'reference' });
      insertLegacyMemory(db, 'bad22222', { category: 'totally-invalid-category' });
    });

    // The INSERT..SELECT into the CHECK'd table hits the bad row → migration throws.
    expect(() => createDatabase({ path: dbPath })).toThrow();

    // Transaction rolled back: the table is still the un-constrained legacy one,
    // and no data was lost.
    const db = new Database(dbPath, { readonly: true });
    try {
      const ddl = (
        db.prepare("SELECT sql FROM sqlite_schema WHERE name='curated_memories'").get() as {
          sql: string;
        }
      ).sql;
      expect(ddl).not.toMatch(/CHECK/i);
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM curated_memories').get() as { n: number }).n,
      ).toBe(2);
      expect(
        (
          db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations').get() as {
            v: number;
          }
        ).v,
      ).toBe(8);
    } finally {
      db.close();
    }
  });
});
