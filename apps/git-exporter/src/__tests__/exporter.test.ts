import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestDatabase,
  MemoryRepository,
  ExportStateRepository,
} from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runExport } from '../exporter.js';
import { makeCuratedMemory, NOW, LATER } from './fixtures.js';
import { formatMemoryAsMarkdown } from '../formatter/markdown-formatter.js';

function makeConfig(outputDir: string, tenantId?: string) {
  return { outputDir, targetId: 'kb-export-default', tenantId };
}

describe('runExport', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let exportStateRepo: ExportStateRepository;
  let outputDir: string;

  beforeEach(() => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    exportStateRepo = new ExportStateRepository(db);
    outputDir = mkdtempSync(join(tmpdir(), 'git-exporter-run-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(outputDir, { recursive: true, force: true });
  });

  it('first export writes all active memories', () => {
    const m1 = makeCuratedMemory({ category: 'pattern', lifecycle: 'active' });
    const m2 = makeCuratedMemory({ category: 'decision', lifecycle: 'active' });
    memoryRepo.insert(m1);
    memoryRepo.insert(m2);

    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

    expect(result.written).toHaveLength(2);
    expect(result.archived).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.unchanged).toBe(0);
    expect(result.totalProcessed).toBe(2);
  });

  it('re-export with no changes produces no new writes (idempotent)', () => {
    const m = makeCuratedMemory({ lifecycle: 'active', updatedAt: NOW });
    memoryRepo.insert(m);

    // First export
    runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

    // Second export — nothing has changed
    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

    expect(result.written).toHaveLength(0);
    expect(result.unchanged).toBe(0); // not in toWrite because filter removes it
    expect(result.totalProcessed).toBe(0);
  });

  it('updates export state after run', () => {
    const m = makeCuratedMemory();
    memoryRepo.insert(m);

    const before = exportStateRepo.get('kb-export-default');
    expect(before).toBeNull();

    runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

    const after = exportStateRepo.get('kb-export-default');
    expect(after).not.toBeNull();
    expect(after!.lastExportedAt).toBeDefined();
  });

  it('written files contain correct frontmatter', () => {
    const m = makeCuratedMemory({
      title: 'Test Pattern',
      category: 'pattern',
      lifecycle: 'active',
    });
    memoryRepo.insert(m);

    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

    expect(result.written).toHaveLength(1);
    const content = readFileSync(result.written[0]!, 'utf8');
    expect(content).toContain(`id: "${m.id}"`);
    expect(content).toContain('title: "Test Pattern"');
    expect(content).toContain('category: "pattern"');
  });

  it('written files are placed in correct subdirectory', () => {
    const pattern = makeCuratedMemory({ category: 'pattern', lifecycle: 'active' });
    const decision = makeCuratedMemory({ category: 'decision', lifecycle: 'active' });
    const guide = makeCuratedMemory({ category: 'reference', lifecycle: 'active' });
    memoryRepo.insert(pattern);
    memoryRepo.insert(decision);
    memoryRepo.insert(guide);

    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

    const paths = result.written;
    expect(paths.some((p) => p.includes('/curated/'))).toBe(true);
    expect(paths.some((p) => p.includes('/decisions/'))).toBe(true);
    expect(paths.some((p) => p.includes('/guides/'))).toBe(true);
  });

  it('archived memory is moved from category dir to archive dir', () => {
    // Seed an archived memory directly
    const m = makeCuratedMemory({ category: 'pattern', lifecycle: 'archived' });
    memoryRepo.insert(m);

    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

    expect(result.archived).toHaveLength(1);
    expect(result.archived[0]).toContain('/archive/');
    expect(result.written).toHaveLength(0);
  });

  it('ExportResult counts are correct for a mixed run', () => {
    const active = makeCuratedMemory({ lifecycle: 'active' });
    const archived = makeCuratedMemory({ lifecycle: 'archived' });
    const supersededById = randomUUID();
    const superseded = makeCuratedMemory({
      lifecycle: 'superseded',
      supersession: { supersededBy: supersededById, reason: 'Replaced', linkedAt: NOW },
    });
    memoryRepo.insert(active);
    memoryRepo.insert(archived);
    memoryRepo.insert(superseded);

    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

    expect(result.written).toHaveLength(1);
    expect(result.archived).toHaveLength(2);
    expect(result.totalProcessed).toBe(3);
  });

  it('new memory added after first export is written on re-export', () => {
    const m1 = makeCuratedMemory({ lifecycle: 'active', updatedAt: NOW });
    memoryRepo.insert(m1);
    // Record NOW as the export timestamp so LATER memories pass the filter
    runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => NOW);

    const m2 = makeCuratedMemory({ lifecycle: 'active', updatedAt: LATER });
    memoryRepo.insert(m2);

    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => LATER);
    expect(result.written).toHaveLength(1);
    expect(result.written[0]).toContain(m2.id);
  });

  it('exports a new memory committed at the exact previous watermark', () => {
    const first = makeCuratedMemory({ updatedAt: NOW });
    memoryRepo.insert(first);
    runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => NOW);
    const second = makeCuratedMemory({ category: 'decision', updatedAt: NOW });
    memoryRepo.insert(second);
    const expectedPath = join(outputDir, 'decisions', `${second.id}.md`);
    const incremental = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => NOW);
    const existedAfterIncremental = existsSync(expectedPath);
    const recovered = runExport(
      memoryRepo,
      exportStateRepo,
      { ...makeConfig(outputDir), reconcile: true },
      () => NOW,
    );
    if (existedAfterIncremental) expect(recovered.written).not.toContain(expectedPath);
    else expect(recovered.written).toContain(expectedPath);
    expect(recovered.quarantined).toEqual([]);
    expect(readFileSync(expectedPath, 'utf8')).toBe(formatMemoryAsMarkdown(second));
    expect(incremental.written).toContain(expectedPath);
    expect(existedAfterIncremental).toBe(true);
  });

  it('content-compares an unchanged same-boundary rerun without duplicate writes', () => {
    const memory = makeCuratedMemory({ updatedAt: NOW });
    memoryRepo.insert(memory);
    const first = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => NOW);
    expect(first.written).toHaveLength(1);
    const file = first.written[0]!;
    const before = readFileSync(file, 'utf8');
    const clock = vi.fn(() => NOW);
    const repeated = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), clock);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(repeated.written).toEqual([]);
    expect(repeated.archived).toEqual([]);
    expect(repeated.quarantined).toEqual([]);
    expect(repeated.unchanged).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(exportStateRepo.get('kb-export-default')?.lastExportedAt).toBe(NOW);
  });

  it('exports a same-watermark content update rather than retaining stale bytes', () => {
    const memory = makeCuratedMemory({ updatedAt: NOW });
    memoryRepo.insert(memory);
    const first = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => NOW);
    const file = first.written[0]!;
    const updated = makeCuratedMemory({
      ...memory,
      content: 'Updated synthetic export boundary content',
      contentHash: undefined,
      updatedAt: NOW,
      version: 2,
    });
    memoryRepo.update(updated);
    runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => NOW);
    const incrementalBytes = readFileSync(file, 'utf8');
    runExport(
      memoryRepo,
      exportStateRepo,
      { ...makeConfig(outputDir), reconcile: true },
      () => NOW,
    );
    expect(readFileSync(file, 'utf8')).toBe(formatMemoryAsMarkdown(updated));
    expect(incrementalBytes).toBe(formatMemoryAsMarkdown(updated));
  });

  it('archives a lifecycle change committed at the exact previous watermark', () => {
    const memory = makeCuratedMemory({ category: 'decision', updatedAt: NOW });
    memoryRepo.insert(memory);
    const first = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => NOW);
    const originalPath = first.written[0]!;
    const archived = makeCuratedMemory({
      ...memory,
      lifecycle: 'archived',
      updatedAt: NOW,
      version: 2,
    });
    memoryRepo.update(archived);
    const archivePath = join(outputDir, 'archive', `${memory.id}.md`);
    const incremental = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => NOW);
    const activeAfterIncremental = existsSync(originalPath);
    const archivedAfterIncremental = existsSync(archivePath);
    runExport(
      memoryRepo,
      exportStateRepo,
      { ...makeConfig(outputDir), reconcile: true },
      () => NOW,
    );
    expect(existsSync(originalPath)).toBe(false);
    expect(readFileSync(archivePath, 'utf8')).toBe(formatMemoryAsMarkdown(archived));
    expect(incremental.archived).toContain(archivePath);
    expect(activeAfterIncremental).toBe(false);
    expect(archivedAfterIncremental).toBe(true);
  });

  it('does not skip a commit between the source snapshot and export completion', () => {
    const first = makeCuratedMemory({ updatedAt: NOW });
    const during = makeCuratedMemory({
      category: 'decision',
      updatedAt: '2026-01-15T12:00:00.000Z',
    });
    memoryRepo.insert(first);
    let clock = NOW;
    const originalRead = memoryRepo.findByTenantResilient.bind(memoryRepo);
    const read = vi
      .spyOn(memoryRepo, 'findByTenantResilient')
      .mockImplementationOnce((tenantId) => {
        const snapshot = originalRead(tenantId);
        memoryRepo.insert(during);
        clock = LATER;
        return snapshot;
      });
    const config = makeConfig(outputDir, first.tenantId);
    runExport(memoryRepo, exportStateRepo, config, () => clock);
    read.mockRestore();
    const expectedPath = join(outputDir, 'decisions', `${during.id}.md`);
    const incremental = runExport(memoryRepo, exportStateRepo, config, () => LATER);
    const existedAfterIncremental = existsSync(expectedPath);
    runExport(memoryRepo, exportStateRepo, { ...config, reconcile: true }, () => LATER);
    expect(readFileSync(expectedPath, 'utf8')).toBe(formatMemoryAsMarkdown(during));
    expect(incremental.written).toContain(expectedPath);
    expect(existedAfterIncremental).toBe(true);
  });

  it('memory updated after first export is re-written', () => {
    const m = makeCuratedMemory({ lifecycle: 'active', updatedAt: NOW });
    memoryRepo.insert(m);
    // Record NOW so the subsequent LATER update is detected
    runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => NOW);

    // Update the memory
    memoryRepo.update({ ...m, content: 'Updated content here', updatedAt: LATER, version: 2 });

    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => LATER);
    expect(result.written).toHaveLength(1);
    const content = readFileSync(result.written[0]!, 'utf8');
    expect(content).toContain('Updated content here');
  });

  it('superseded memory after first export is archived on re-export', () => {
    const m = makeCuratedMemory({ lifecycle: 'active', updatedAt: NOW });
    memoryRepo.insert(m);
    // Record NOW so the LATER supersession is detected on re-export
    runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => NOW);

    // Transition to superseded
    const supersededById = randomUUID();
    memoryRepo.update({
      ...m,
      lifecycle: 'superseded',
      supersession: { supersededBy: supersededById, reason: 'Replaced', linkedAt: LATER },
      updatedAt: LATER,
      version: 2,
    });

    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => LATER);
    expect(result.archived).toHaveLength(1);
    expect(result.archived[0]).toContain('/archive/');
    expect(result.written).toHaveLength(0);
  });

  it('full cycle: write → supersede → re-export → archive removes source file', () => {
    // Step 1: initial export — record NOW as the export timestamp
    const m = makeCuratedMemory({ category: 'pattern', lifecycle: 'active', updatedAt: NOW });
    memoryRepo.insert(m);
    const first = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => NOW);
    expect(first.written).toHaveLength(1);
    const originalPath = first.written[0]!;
    expect(existsSync(originalPath)).toBe(true);

    // Step 2: supersede and re-export — LATER > NOW so the update is detected
    const supersededById = randomUUID();
    memoryRepo.update({
      ...m,
      lifecycle: 'superseded',
      supersession: { supersededBy: supersededById, reason: 'Replaced', linkedAt: LATER },
      updatedAt: LATER,
      version: 2,
    });
    const second = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir), () => LATER);

    // Original file is removed, archive file is created
    expect(existsSync(originalPath)).toBe(false);
    expect(second.archived).toHaveLength(1);
    expect(existsSync(second.archived[0]!)).toBe(true);
  });

  it('empty database produces an empty result', () => {
    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));
    expect(result.written).toHaveLength(0);
    expect(result.archived).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.unchanged).toBe(0);
    expect(result.totalProcessed).toBe(0);
  });

  describe('export gating', () => {
    it('memory with sensitivity=restricted is skipped and its ID appears in skipped array', () => {
      const m = makeCuratedMemory({ lifecycle: 'active', sensitivity: 'restricted' });
      memoryRepo.insert(m);

      const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

      expect(result.written).toHaveLength(0);
      expect(result.skipped).toContain(m.id);
    });

    it('memory with sensitivity=confidential is skipped', () => {
      const m = makeCuratedMemory({ lifecycle: 'active', sensitivity: 'confidential' });
      memoryRepo.insert(m);

      const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

      expect(result.written).toHaveLength(0);
      expect(result.skipped).toContain(m.id);
    });

    it('memory with sensitivity=internal is written normally', () => {
      const m = makeCuratedMemory({ lifecycle: 'active', sensitivity: 'internal' });
      memoryRepo.insert(m);

      const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

      expect(result.written).toHaveLength(1);
      expect(result.skipped).toHaveLength(0);
    });
  });

  it('idempotency check increments unchanged count when file content matches', () => {
    const m = makeCuratedMemory({ lifecycle: 'active', updatedAt: NOW });
    memoryRepo.insert(m);

    // First export creates the file
    runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

    // Manually force the memory into toWrite by resetting export state
    // so it passes the date filter, but content hasn't changed.
    // Write the file with identical content before second export
    const filePath = join(outputDir, 'curated', `${m.id}.md`);
    const content = formatMemoryAsMarkdown(m);
    mkdirSync(join(outputDir, 'curated'), { recursive: true });
    writeFileSync(filePath, content, 'utf8');

    // Force re-run via state manipulation: set lastExportedAt before memory's updatedAt
    exportStateRepo.set('kb-export-default', '2025-01-01T00:00:00.000Z');

    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));
    expect(result.unchanged).toBe(1);
    expect(result.written).toHaveLength(0);
  });

  // ─── Per-memory quarantine (5bm.12) ────────────────────────────────────────

  it('quarantines a corrupt-category row and still exports the healthy ones', () => {
    const good1 = makeCuratedMemory({ category: 'pattern', lifecycle: 'active' });
    const good2 = makeCuratedMemory({ category: 'decision', lifecycle: 'active' });
    const bad = makeCuratedMemory({ category: 'convention', lifecycle: 'active' });
    memoryRepo.insert(good1);
    memoryRepo.insert(good2);
    memoryRepo.insert(bad);
    // Plant a pre-CHECK-style corrupt category the mapper/schema will reject.
    db.pragma('ignore_check_constraints = ON');
    db.prepare('UPDATE curated_memories SET category = ? WHERE id = ?').run(
      'gone-category',
      bad.id,
    );
    db.pragma('ignore_check_constraints = OFF');

    // The run does NOT throw even though one row is unreadable.
    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));

    // Both healthy memories exported; the corrupt one set aside + named.
    expect(result.written).toHaveLength(2);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]!.id).toBe(bad.id);
    expect(result.quarantined[0]!.reason).toMatch(/category/i);
    // No file was written for the quarantined memory.
    for (const path of result.written) {
      expect(path).not.toContain(bad.id);
    }
  });

  it('reports an empty quarantine list when every memory is healthy', () => {
    memoryRepo.insert(makeCuratedMemory({ category: 'pattern', lifecycle: 'active' }));
    const result = runExport(memoryRepo, exportStateRepo, makeConfig(outputDir));
    expect(result.quarantined).toEqual([]);
  });
});
