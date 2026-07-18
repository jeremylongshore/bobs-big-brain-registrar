import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
