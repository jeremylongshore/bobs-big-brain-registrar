import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestDatabase,
  MemoryRepository,
  ExportStateRepository,
} from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runExport } from '../exporter.js';
import { isExportRestricted } from '../sensitivity.js';
import { makeCuratedMemory, LATER, TENANT } from './fixtures.js';

/**
 * Claim-level audience at the export boundary (Epic K bead K2).
 *
 * The export tree feeds ONE shared search index per tenant. Only tenant-wide
 * memories may be written to it; `admins` / `owner` memories are excluded until
 * per-audience indexes exist.
 */
const meta = (audience?: string) => ({
  filePaths: [],
  tags: [],
  ...(audience !== undefined ? { audience } : {}),
});

describe('isExportRestricted', () => {
  it.each([
    ['internal', undefined, false],
    ['internal', 'tenant', false],
    ['public', 'tenant', false],
    ['internal', 'admins', true],
    ['internal', 'owner', true],
    ['public', 'owner', true],
    ['confidential', undefined, true],
    ['restricted', 'tenant', true],
    ['restricted', 'owner', true],
  ] as const)('sensitivity=%s audience=%s -> restricted %s', (sensitivity, audience, expected) => {
    const memory = makeCuratedMemory({ sensitivity, metadata: meta(audience) });
    expect(isExportRestricted(memory)).toBe(expected);
  });

  it('fails closed on an audience value it does not recognize', () => {
    const memory = makeCuratedMemory();
    (memory.metadata as Record<string, unknown>)['audience'] = 'board';
    expect(isExportRestricted(memory)).toBe(true);
  });
});

describe('runExport — audience exclusion', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let exportStateRepo: ExportStateRepository;
  let out: string;

  const cfg = (reconcile = false) => ({
    outputDir: out,
    targetId: 'kb-export-default',
    tenantId: TENANT,
    reconcile,
  });

  /** Every file under the export tree, with its full text. */
  function tree(): Array<{ path: string; text: string }> {
    return ['decisions', 'curated', 'guides', 'archive', 'bulk'].flatMap((d) => {
      const dir = join(out, d);
      if (!existsSync(dir)) return [];
      return readdirSync(dir).map((f: string) => ({
        path: `${d}/${f}`,
        text: readFileSync(join(dir, f), 'utf8'),
      }));
    });
  }

  beforeEach(() => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    exportStateRepo = new ExportStateRepository(db);
    out = mkdtempSync(join(tmpdir(), 'git-exporter-audience-'));
  });
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
    db.close();
  });

  it.each([false, true])(
    'exports tenant-wide memories and skips admins/owner ones (reconcile=%s)',
    (reconcile) => {
      const legacy = makeCuratedMemory({ content: 'legacy tenant-wide body' });
      const tenant = makeCuratedMemory({
        content: 'explicit tenant body',
        metadata: meta('tenant'),
      });
      const admins = makeCuratedMemory({ content: 'ADMINS-ONLY-BODY', metadata: meta('admins') });
      const owner = makeCuratedMemory({ content: 'OWNER-ONLY-BODY', metadata: meta('owner') });
      for (const m of [legacy, tenant, admins, owner]) memoryRepo.insert(m);

      const result = runExport(memoryRepo, exportStateRepo, cfg(reconcile));

      expect(result.written).toHaveLength(2);
      expect([...result.skipped].sort()).toEqual([admins.id, owner.id].sort());
      const files = tree();
      expect(files.map((f) => f.path).sort()).toEqual(
        [`curated/${legacy.id}.md`, `curated/${tenant.id}.md`].sort(),
      );
      const all = files.map((f) => f.text).join('\n');
      expect(all).not.toContain('ADMINS-ONLY-BODY');
      expect(all).not.toContain('OWNER-ONLY-BODY');
      expect(all).not.toContain(admins.id);
      expect(all).not.toContain(owner.id);
    },
  );

  it('does not write a narrower memory to archive/ either', () => {
    const owner = makeCuratedMemory({
      content: 'OWNER-ONLY-ARCHIVED',
      lifecycle: 'archived',
      metadata: meta('owner'),
    });
    memoryRepo.insert(owner);
    const result = runExport(memoryRepo, exportStateRepo, cfg());
    expect(result.archived).toHaveLength(0);
    expect(result.skipped).toEqual([owner.id]);
    expect(tree()).toEqual([]);
  });

  it('the exported bytes of a memory with no audience are unchanged (no new frontmatter key)', () => {
    const legacy = makeCuratedMemory();
    memoryRepo.insert(legacy);
    runExport(memoryRepo, exportStateRepo, cfg());
    expect(tree()[0]!.text).not.toMatch(/audience/);
  });

  it('reconcile removes the on-disk copy of a memory whose audience was narrowed', () => {
    const m = makeCuratedMemory({ category: 'decision', content: 'was tenant-wide, now narrowed' });
    memoryRepo.insert(m);
    runExport(memoryRepo, exportStateRepo, cfg(true));
    const file = join(out, 'decisions', `${m.id}.md`);
    expect(existsSync(file)).toBe(true);

    memoryRepo.update({ ...m, metadata: meta('admins') as never, updatedAt: LATER, version: 2 });
    const result = runExport(memoryRepo, exportStateRepo, cfg(true));

    expect(result.skipped).toContain(m.id);
    expect(result.removed).toEqual([file]);
    expect(existsSync(file)).toBe(false);
  });

  it('a second reconcile over a tree with excluded memories is a clean no-op', () => {
    memoryRepo.insert(makeCuratedMemory({ content: 'tenant body' }));
    memoryRepo.insert(makeCuratedMemory({ content: 'owner body', metadata: meta('owner') }));
    runExport(memoryRepo, exportStateRepo, cfg(true));
    const before = tree();
    const again = runExport(memoryRepo, exportStateRepo, cfg(true));
    expect(again.written).toHaveLength(0);
    expect(again.removed).toHaveLength(0);
    expect(tree()).toEqual(before);
  });
});
