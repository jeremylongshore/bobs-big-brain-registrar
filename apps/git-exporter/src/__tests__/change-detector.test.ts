import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestDatabase,
  MemoryRepository,
  ExportStateRepository,
} from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';
import { detectChanges } from '../diff/change-detector.js';
import { makeCuratedMemory, NOW, LATER, TENANT } from './fixtures.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const OUTPUT_DIR = '/tmp/kb-export-test';
const TARGET_ID = 'kb-export-default';

function makeConfig(tenantId?: string) {
  return { outputDir: OUTPUT_DIR, targetId: TARGET_ID, tenantId };
}

describe('detectChanges', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let exportStateRepo: ExportStateRepository;

  beforeEach(() => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    exportStateRepo = new ExportStateRepository(db);
  });

  it('first run with no export state returns all memories', () => {
    const m1 = makeCuratedMemory({ lifecycle: 'active' });
    const m2 = makeCuratedMemory({ lifecycle: 'active' });
    memoryRepo.insert(m1);
    memoryRepo.insert(m2);

    const changeset = detectChanges(memoryRepo, exportStateRepo, makeConfig());
    expect(changeset.toWrite).toHaveLength(2);
    expect(changeset.toArchive).toHaveLength(0);
    expect(changeset.toRemove).toHaveLength(0);
  });

  it('subsequent run with no updated memories returns empty changeset', () => {
    const m = makeCuratedMemory({ updatedAt: NOW });
    memoryRepo.insert(m);
    exportStateRepo.set(TARGET_ID, LATER); // export timestamp is after memory

    const changeset = detectChanges(memoryRepo, exportStateRepo, makeConfig());
    expect(changeset.toWrite).toHaveLength(0);
    expect(changeset.toArchive).toHaveLength(0);
  });

  it('detects newly added memory after last export', () => {
    const old = makeCuratedMemory({ updatedAt: NOW });
    memoryRepo.insert(old);
    exportStateRepo.set(TARGET_ID, NOW); // exported exactly at NOW

    const newMemory = makeCuratedMemory({ updatedAt: LATER });
    memoryRepo.insert(newMemory);

    const changeset = detectChanges(memoryRepo, exportStateRepo, makeConfig());
    expect(changeset.toWrite).toHaveLength(1);
    expect(changeset.toWrite[0]?.memory.id).toBe(newMemory.id);
  });

  it('detects memory updated after last export timestamp', () => {
    const m = makeCuratedMemory({ updatedAt: NOW });
    memoryRepo.insert(m);
    exportStateRepo.set(TARGET_ID, NOW);

    // Simulate update: re-insert with later timestamp
    memoryRepo.update({ ...m, updatedAt: LATER, version: 2 });

    const changeset = detectChanges(memoryRepo, exportStateRepo, makeConfig());
    expect(changeset.toWrite).toHaveLength(1);
  });

  it('superseded memory goes to toArchive', () => {
    const supersededById = randomUUID();
    const m = makeCuratedMemory({
      lifecycle: 'superseded',
      supersession: { supersededBy: supersededById, reason: 'Updated', linkedAt: NOW },
    });
    memoryRepo.insert(m);

    const changeset = detectChanges(memoryRepo, exportStateRepo, makeConfig());
    expect(changeset.toArchive).toHaveLength(1);
    expect(changeset.toWrite).toHaveLength(0);
  });

  it('archived memory goes to toArchive', () => {
    const m = makeCuratedMemory({ lifecycle: 'archived' });
    memoryRepo.insert(m);

    const changeset = detectChanges(memoryRepo, exportStateRepo, makeConfig());
    expect(changeset.toArchive).toHaveLength(1);
    expect(changeset.toWrite).toHaveLength(0);
  });

  it('tenant filter returns only memories for that tenant', () => {
    const m1 = makeCuratedMemory({ tenantId: TENANT });
    const m2 = makeCuratedMemory({ tenantId: 'team-beta' });
    memoryRepo.insert(m1);
    memoryRepo.insert(m2);

    const changeset = detectChanges(memoryRepo, exportStateRepo, makeConfig(TENANT));
    expect(changeset.toWrite).toHaveLength(1);
    expect(changeset.toWrite[0]?.memory.tenantId).toBe(TENANT);
  });

  it('archive toArchive has correct fromPath in category directory', () => {
    const m = makeCuratedMemory({ category: 'pattern', lifecycle: 'archived' });
    memoryRepo.insert(m);

    const changeset = detectChanges(memoryRepo, exportStateRepo, makeConfig());
    const item = changeset.toArchive[0];
    expect(item).toBeDefined();
    expect(item!.fromPath).toBe(join(OUTPUT_DIR, 'curated', `${m.id}.md`));
  });

  it('archive toArchive has correct toPath in archive directory', () => {
    const m = makeCuratedMemory({ category: 'decision', lifecycle: 'archived' });
    memoryRepo.insert(m);

    const changeset = detectChanges(memoryRepo, exportStateRepo, makeConfig());
    const item = changeset.toArchive[0];
    expect(item).toBeDefined();
    expect(item!.toPath).toBe(join(OUTPUT_DIR, 'archive', `${m.id}.md`));
  });

  it('mixed lifecycle memories are correctly distributed across toWrite and toArchive', () => {
    const active = makeCuratedMemory({ lifecycle: 'active' });
    const deprecated = makeCuratedMemory({ lifecycle: 'deprecated' });
    const archived = makeCuratedMemory({ lifecycle: 'archived' });
    const supersededById = randomUUID();
    const superseded = makeCuratedMemory({
      lifecycle: 'superseded',
      supersession: { supersededBy: supersededById, reason: 'Replaced', linkedAt: NOW },
    });

    memoryRepo.insert(active);
    memoryRepo.insert(deprecated);
    memoryRepo.insert(archived);
    memoryRepo.insert(superseded);

    const changeset = detectChanges(memoryRepo, exportStateRepo, makeConfig());
    expect(changeset.toWrite).toHaveLength(2); // active + deprecated
    expect(changeset.toArchive).toHaveLength(2); // archived + superseded
  });

  it('quarantines an unreadable row (5bm.12) without dropping the healthy ones', () => {
    const good = makeCuratedMemory({ category: 'pattern', lifecycle: 'active' });
    const bad = makeCuratedMemory({ category: 'decision', lifecycle: 'active' });
    memoryRepo.insert(good);
    memoryRepo.insert(bad);
    db.pragma('ignore_check_constraints = ON');
    db.prepare('UPDATE curated_memories SET category = ? WHERE id = ?').run('vanished', bad.id);
    db.pragma('ignore_check_constraints = OFF');

    const changeset = detectChanges(memoryRepo, exportStateRepo, makeConfig());
    expect(changeset.toWrite.map((w) => w.memory.id)).toEqual([good.id]);
    expect(changeset.quarantined).toHaveLength(1);
    expect(changeset.quarantined[0]!.id).toBe(bad.id);
  });
});
