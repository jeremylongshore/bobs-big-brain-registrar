/**
 * MemoryRepository resilient batch-read tests (bead qmd-team-intent-kb-5bm.12).
 *
 * `findByLifecycle` / `findByTenant` map every row through `rowToMemory`, which
 * THROWS on a row that fails domain validation (e.g. a legacy category later
 * removed from the enum). One such row therefore aborts the whole batch — and,
 * downstream, the whole git-export run. `findByLifecycleResilient` /
 * `findByTenantResilient` isolate the failure per-row so healthy memories still
 * come back and the bad row is reported for quarantine.
 *
 * A genuinely-corrupt row is planted by inserting a valid memory then raw-
 * UPDATE-ing its category under `ignore_check_constraints` — exactly the shape
 * of a pre-CHECK legacy row (SQLite CHECK guards writes, not existing data).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { MemoryRepository } from '../repositories/memory-repository.js';
import { makeMemory } from './fixtures.js';

/** Plant an off-vocabulary category on an existing row, bypassing the CHECK. */
function corruptCategory(db: Database.Database, id: string, badCategory: string): void {
  db.pragma('ignore_check_constraints = ON');
  try {
    db.prepare('UPDATE curated_memories SET category = ? WHERE id = ?').run(badCategory, id);
  } finally {
    db.pragma('ignore_check_constraints = OFF');
  }
}

describe('MemoryRepository.findByLifecycleResilient (5bm.12)', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryRepository(db);
  });

  it('returns healthy memories and isolates a corrupt row instead of throwing', () => {
    const good = makeMemory({ title: 'Healthy', lifecycle: 'active' });
    const bad = makeMemory({ title: 'Corrupt', lifecycle: 'active', contentHash: 'c'.repeat(64) });
    repo.insert(good);
    repo.insert(bad);
    corruptCategory(db, bad.id, 'not-a-real-category');

    // The strict read blows up the whole batch on the corrupt row...
    expect(() => repo.findByLifecycle('active')).toThrow();

    // ...the resilient read returns the healthy one and names the bad one.
    const { memories, failures } = repo.findByLifecycleResilient('active');
    expect(memories.map((m) => m.id)).toEqual([good.id]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.id).toBe(bad.id);
    expect(failures[0]!.reason).toMatch(/category/i);
  });

  it('reports no failures when every row is valid', () => {
    repo.insert(makeMemory({ lifecycle: 'active' }));
    const { memories, failures } = repo.findByLifecycleResilient('active');
    expect(memories).toHaveLength(1);
    expect(failures).toHaveLength(0);
  });
});

describe('MemoryRepository.findByTenantResilient (5bm.12)', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryRepository(db);
  });

  it('isolates a corrupt tenant row', () => {
    const good = makeMemory({ tenantId: 'team-alpha', title: 'Good' });
    const bad = makeMemory({
      tenantId: 'team-alpha',
      title: 'Bad',
      contentHash: 'd'.repeat(64),
    });
    repo.insert(good);
    repo.insert(bad);
    corruptCategory(db, bad.id, 'nope');

    const { memories, failures } = repo.findByTenantResilient('team-alpha');
    expect(memories.map((m) => m.id)).toEqual([good.id]);
    expect(failures.map((f) => f.id)).toEqual([bad.id]);
  });
});
