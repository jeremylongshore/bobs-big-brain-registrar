import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestDatabase,
  MemoryRepository,
  ExportStateRepository,
} from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runExport } from '../exporter.js';
import { detectChanges } from '../diff/change-detector.js';
import { makeCuratedMemory, NOW, LATER, TENANT } from './fixtures.js';
import { formatMemoryAsMarkdown } from '../formatter/markdown-formatter.js';

/**
 * Reconcile mode: the export tree is converged on the DB as a whole, so
 * lifecycle changes made outside a promotion (curator batch-transition) land on
 * disk, a crashed run is repaired by the next one, and a clean re-run is a no-op.
 */
describe('runExport — reconcile mode', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let exportStateRepo: ExportStateRepository;
  let out: string;

  const cfg = (extra: Record<string, unknown> = {}) => ({
    outputDir: out,
    targetId: 'kb-export-default',
    tenantId: TENANT,
    reconcile: true,
    ...extra,
  });
  const incremental = () => ({ outputDir: out, targetId: 'kb-export-default', tenantId: TENANT });

  beforeEach(() => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    exportStateRepo = new ExportStateRepository(db);
    out = mkdtempSync(join(tmpdir(), 'git-exporter-reconcile-'));
  });
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  function stateTable(): string[] {
    return ['decisions', 'curated', 'guides', 'archive', 'bulk'].flatMap((d) => {
      const dir = join(out, d);
      if (!existsSync(dir)) return [];
      return readdirSync(dir).map((f: string) => `${d}/${f}`);
    });
  }

  it('moves a batch-transitioned memory to archive/ even when updatedAt was not bumped', () => {
    const m = makeCuratedMemory({ category: 'decision', updatedAt: NOW });
    memoryRepo.insert(m);
    runExport(memoryRepo, exportStateRepo, incremental(), () => LATER);
    expect(existsSync(join(out, 'decisions', `${m.id}.md`))).toBe(true);

    // Lifecycle change that does NOT advance updatedAt past the export watermark:
    // the incremental detector filters it out and would never see it.
    memoryRepo.updateLifecycle(m.id, 'archived', NOW);
    const inc = runExport(memoryRepo, exportStateRepo, incremental(), () => LATER);
    expect(inc.archived).toHaveLength(0);
    expect(existsSync(join(out, 'decisions', `${m.id}.md`))).toBe(true); // still stale

    const rec = runExport(memoryRepo, exportStateRepo, cfg(), () => LATER);
    expect(rec.archived).toEqual([join(out, 'archive', `${m.id}.md`)]);
    expect(existsSync(join(out, 'decisions', `${m.id}.md`))).toBe(false);
    expect(readFileSync(join(out, 'archive', `${m.id}.md`), 'utf8')).toContain(
      'lifecycle: "archived"',
    );
  });

  it('reports archive moves in the result (the exported:0 regression)', () => {
    const m = makeCuratedMemory({ category: 'pattern' });
    memoryRepo.insert(m);
    runExport(memoryRepo, exportStateRepo, incremental());
    memoryRepo.updateLifecycle(m.id, 'archived', LATER);

    const r = runExport(memoryRepo, exportStateRepo, cfg());
    expect(r.written).toHaveLength(0);
    expect(r.archived).toHaveLength(1);
    expect(r.removed).toHaveLength(0);
  });

  it('is idempotent: a second reconcile writes, archives and removes nothing', () => {
    const a = makeCuratedMemory({ category: 'decision' });
    const b = makeCuratedMemory({ category: 'reference' });
    const c = makeCuratedMemory({ category: 'pattern', lifecycle: 'archived' });
    [a, b, c].forEach((m) => memoryRepo.insert(m));

    const first = runExport(memoryRepo, exportStateRepo, cfg());
    expect(first.written).toHaveLength(2);
    expect(first.archived).toHaveLength(1);

    const before = stateTable();
    const second = runExport(memoryRepo, exportStateRepo, cfg());
    expect(second.written).toHaveLength(0);
    expect(second.archived).toHaveLength(0);
    expect(second.removed).toHaveLength(0);
    expect(second.unchanged).toBe(3);
    expect(stateTable()).toEqual(before);
  });

  it('repairs a deleted file even though export state says it was exported', () => {
    const m = makeCuratedMemory({ category: 'reference' });
    memoryRepo.insert(m);
    runExport(memoryRepo, exportStateRepo, cfg());
    const file = join(out, 'guides', `${m.id}.md`);
    unlinkSync(file);

    // Incremental trusts the watermark and does nothing; reconcile restores it.
    expect(runExport(memoryRepo, exportStateRepo, incremental()).written).toHaveLength(0);
    expect(existsSync(file)).toBe(false);
    expect(runExport(memoryRepo, exportStateRepo, cfg()).written).toEqual([file]);
    expect(readFileSync(file, 'utf8')).toBe(formatMemoryAsMarkdown(m));
  });

  it('crash mid-write: a truncated file is rewritten on the next run', () => {
    const m = makeCuratedMemory({ category: 'decision' });
    memoryRepo.insert(m);
    runExport(memoryRepo, exportStateRepo, cfg());
    const file = join(out, 'decisions', `${m.id}.md`);
    writeFileSync(file, readFileSync(file, 'utf8').slice(0, 40)); // torn write

    const r = runExport(memoryRepo, exportStateRepo, cfg());
    expect(r.written).toEqual([file]);
    expect(readFileSync(file, 'utf8')).toBe(formatMemoryAsMarkdown(m));
    expect(runExport(memoryRepo, exportStateRepo, cfg()).written).toHaveLength(0);
  });

  it('crash after the archive copy was written but before the old copy was unlinked', () => {
    const m = makeCuratedMemory({ category: 'decision' });
    memoryRepo.insert(m);
    runExport(memoryRepo, exportStateRepo, cfg());
    memoryRepo.updateLifecycle(m.id, 'archived', LATER);
    // Simulate the interrupted run: archive copy exists, active copy still there.
    const archived = memoryRepo.findById(m.id)!;
    mkdirSync(join(out, 'archive'), { recursive: true });
    writeFileSync(join(out, 'archive', `${m.id}.md`), formatMemoryAsMarkdown(archived));

    const r = runExport(memoryRepo, exportStateRepo, cfg());
    expect(r.removed.concat(r.archived).length).toBeGreaterThan(0);
    expect(existsSync(join(out, 'decisions', `${m.id}.md`))).toBe(false);
    expect(existsSync(join(out, 'archive', `${m.id}.md`))).toBe(true);
    const again = runExport(memoryRepo, exportStateRepo, cfg());
    expect([again.written, again.archived, again.removed].map((x) => x.length)).toEqual([0, 0, 0]);
  });

  it('removes a stale copy left in the wrong directory (recategorized memory)', () => {
    const m = makeCuratedMemory({ category: 'reference' });
    memoryRepo.insert(m);
    mkdirSync(join(out, 'decisions'), { recursive: true });
    const stale = join(out, 'decisions', `${m.id}.md`);
    writeFileSync(stale, formatMemoryAsMarkdown(m));

    const r = runExport(memoryRepo, exportStateRepo, cfg());
    expect(r.removed).toEqual([stale]);
    expect(existsSync(join(out, 'guides', `${m.id}.md`))).toBe(true);
  });

  it('removes the on-disk copy of a memory that became restricted', () => {
    const m = makeCuratedMemory({ category: 'decision', sensitivity: 'internal' });
    memoryRepo.insert(m);
    runExport(memoryRepo, exportStateRepo, cfg());
    const file = join(out, 'decisions', `${m.id}.md`);
    expect(existsSync(file)).toBe(true);

    memoryRepo.update({ ...m, sensitivity: 'restricted', updatedAt: LATER, version: 2 });
    const r = runExport(memoryRepo, exportStateRepo, cfg());
    expect(r.skipped).toContain(m.id);
    expect(r.removed).toEqual([file]);
    expect(existsSync(file)).toBe(false);
  });

  describe('orphans', () => {
    function plantOrphan(tenant: string | null, id = randomUUID(), dir = 'curated'): string {
      mkdirSync(join(out, dir), { recursive: true });
      const p = join(out, dir, `${id}.md`);
      const fm =
        tenant === null ? 'no frontmatter' : `---\nid: "${id}"\ntenant_id: "${tenant}"\n---\nbody`;
      writeFileSync(p, fm);
      return p;
    }

    it("removes this tenant's orphan; leaves other tenants, unattributable and non-memory files", () => {
      const keep = makeCuratedMemory({ category: 'pattern' });
      memoryRepo.insert(keep);
      const mine = plantOrphan(TENANT);
      const theirs = plantOrphan('someone-else');
      const unattributed = plantOrphan(null);
      const notUuid = join(out, 'curated', 'README.md');
      writeFileSync(notUuid, 'hand-written');

      const r = runExport(memoryRepo, exportStateRepo, cfg());
      expect(r.removed).toEqual([mine]);
      expect(existsSync(theirs)).toBe(true);
      expect(existsSync(unattributed)).toBe(true);
      expect(existsSync(notUuid)).toBe(true);
      expect(existsSync(join(out, 'curated', `${keep.id}.md`))).toBe(true);
    });

    it('a mis-filed copy that positively names another tenant is never removed, even for a known id', () => {
      const m = makeCuratedMemory({ category: 'reference' });
      memoryRepo.insert(m);
      mkdirSync(join(out, 'decisions'), { recursive: true });
      const foreignCopy = join(out, 'decisions', `${m.id}.md`);
      writeFileSync(foreignCopy, `---\nid: "${m.id}"\ntenant_id: "someone-else"\n---\nx`);

      const r = runExport(memoryRepo, exportStateRepo, cfg());
      expect(r.removed).toEqual([]);
      expect(existsSync(foreignCopy)).toBe(true);
      // Its own copy is still written where it belongs.
      expect(existsSync(join(out, 'guides', `${m.id}.md`))).toBe(true);
    });

    it('without a tenant filter every orphan is removed', () => {
      const a = plantOrphan('t1');
      const b = plantOrphan('t2');
      const r = runExport(memoryRepo, exportStateRepo, { ...cfg(), tenantId: undefined });
      expect(r.removed.sort()).toEqual([a, b].sort());
    });

    it('mass-delete guard: an empty/wrong DB cannot wipe a healthy tree', () => {
      const files = Array.from({ length: 6 }, () => plantOrphan(TENANT));
      const r = runExport(memoryRepo, exportStateRepo, cfg({ maxOrphanRemovals: 5 }));
      expect(r.removed).toHaveLength(0);
      expect(r.removalBlocked).toEqual({ orphans: 6, limit: 5 });
      for (const f of files) expect(existsSync(f)).toBe(true);

      // At the cap it proceeds.
      const ok = runExport(memoryRepo, exportStateRepo, cfg({ maxOrphanRemovals: 6 }));
      expect(ok.removed).toHaveLength(6);
      expect(ok.removalBlocked).toBeUndefined();
    });

    it('the guard does not block safe relocation removals', () => {
      const m = makeCuratedMemory({ category: 'reference' });
      memoryRepo.insert(m);
      mkdirSync(join(out, 'decisions'), { recursive: true });
      const stale = join(out, 'decisions', `${m.id}.md`);
      writeFileSync(stale, formatMemoryAsMarkdown(m));
      plantOrphan(TENANT);
      plantOrphan(TENANT);

      const r = runExport(memoryRepo, exportStateRepo, cfg({ maxOrphanRemovals: 1 }));
      expect(r.removed).toEqual([stale]);
      expect(r.removalBlocked).toEqual({ orphans: 2, limit: 1 });
    });
  });

  it('detectChanges in reconcile mode ignores the watermark; incremental honors it', () => {
    const m = makeCuratedMemory({ updatedAt: NOW });
    memoryRepo.insert(m);
    exportStateRepo.set('kb-export-default', LATER);
    expect(detectChanges(memoryRepo, exportStateRepo, incremental()).toWrite).toHaveLength(0);
    expect(detectChanges(memoryRepo, exportStateRepo, cfg()).toWrite).toHaveLength(1);
  });

  it('skips a missing export root without error and creates files on demand', () => {
    const m = makeCuratedMemory({ category: 'decision' });
    memoryRepo.insert(m);
    rmSync(out, { recursive: true, force: true });
    const r = runExport(memoryRepo, exportStateRepo, cfg());
    expect(r.written).toHaveLength(1);
  });
});
