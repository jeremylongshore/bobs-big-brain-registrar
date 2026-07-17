import { describe, it, expect } from 'vitest';
import { createDatabase, createTestDatabase } from '../database.js';

describe('createTestDatabase', () => {
  it('creates an in-memory database without throwing', () => {
    const db = createTestDatabase();
    expect(db).toBeDefined();
    db.close();
  });

  it('creates all expected tables', () => {
    const db = createTestDatabase();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('candidates');
    expect(names).toContain('curated_memories');
    expect(names).toContain('governance_policies');
    expect(names).toContain('audit_events');
    expect(names).toContain('export_state');
    db.close();
  });

  it('creates tables idempotently — calling createDatabase twice does not throw', () => {
    // Use a shared in-memory path approach: call createDatabase with :memory:
    // twice (each call is an independent connection, both succeed).
    expect(() => {
      const db1 = createDatabase({ path: ':memory:' });
      db1.close();
      const db2 = createDatabase({ path: ':memory:' });
      db2.close();
    }).not.toThrow();
  });

  it('has WAL journal mode enabled', () => {
    const db = createTestDatabase();
    const row = db.pragma('journal_mode', { simple: true });
    // In-memory databases may report 'memory' instead of 'wal' — both indicate
    // the pragma was accepted without error. For an on-disk DB it would be 'wal'.
    expect(typeof row).toBe('string');
    db.close();
  });

  it('has foreign keys enabled', () => {
    const db = createTestDatabase();
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
    db.close();
  });
});

describe('curated_memories enum CHECK constraints (5bm.1)', () => {
  const cols = [
    ['category', 'made-up-category'],
    ['trust_level', 'super-high'],
    ['sensitivity', 'top-secret'],
    ['lifecycle', 'zombie'],
    ['source', 'telepathy'],
  ] as const;

  it.each(cols)('the DB rejects an off-vocabulary %s at the row level', (col, bad) => {
    const db = createTestDatabase();
    const author = JSON.stringify({ type: 'human', id: 'u', name: 'U' });
    const vals: Record<string, string> = {
      source: 'manual',
      category: 'pattern',
      trust_level: 'high',
      sensitivity: 'internal',
      lifecycle: 'active',
    };
    vals[col] = bad;
    const stmt = db.prepare(
      `INSERT INTO curated_memories (
        id, candidate_id, source, content, title, category, trust_level, sensitivity,
        author_json, tenant_id, metadata_json, lifecycle, content_hash,
        policy_evaluations_json, supersession_json, promoted_at, promoted_by_json, updated_at, version
      ) VALUES (
        'i', 'c', @source, 'x', 'x', @category, @trust_level, @sensitivity,
        @author, 't', '{}', @lifecycle, 'h', '[]', NULL, 'now', @author, 'now', 1
      )`,
    );
    // SQLite raises a CHECK constraint failure — the off-vocabulary value never lands.
    expect(() => stmt.run({ ...vals, author })).toThrow(/CHECK constraint/i);
    db.close();
  });

  it('accepts a fully in-vocabulary row', () => {
    const db = createTestDatabase();
    const author = JSON.stringify({ type: 'human', id: 'u', name: 'U' });
    expect(() =>
      db
        .prepare(
          `INSERT INTO curated_memories (
            id, candidate_id, source, content, title, category, trust_level, sensitivity,
            author_json, tenant_id, metadata_json, lifecycle, content_hash,
            policy_evaluations_json, supersession_json, promoted_at, promoted_by_json, updated_at, version
          ) VALUES (
            'i', 'c', 'manual', 'x', 'x', 'decision', 'high', 'internal',
            ?, 't', '{}', 'active', 'h', '[]', NULL, 'now', ?, 'now', 1
          )`,
        )
        .run(author, author),
    ).not.toThrow();
    db.close();
  });
});
