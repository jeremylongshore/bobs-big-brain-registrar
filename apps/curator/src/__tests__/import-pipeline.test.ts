import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  MemoryRepository,
  CandidateRepository,
  ImportBatchRepository,
} from '@qmd-team-intent-kb/store';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { previewImport, executeImport, rollbackImport } from '../import/import-pipeline.js';
import type { ImportDependencies } from '../import/import-pipeline.js';
import { makeCuratedMemory } from './fixtures.js';

const TENANT = 'test-tenant';
const NOW = '2026-01-15T10:00:00.000Z';

function setupDeps(db: Database.Database): ImportDependencies {
  return {
    memoryRepo: new MemoryRepository(db),
    candidateRepo: new CandidateRepository(db),
    batchRepo: new ImportBatchRepository(db),
  };
}

describe('previewImport', () => {
  let db: Database.Database;
  let deps: ImportDependencies;
  let vaultDir: string;

  beforeEach(() => {
    db = createTestDatabase();
    deps = setupDeps(db);
    vaultDir = mkdtempSync(join(tmpdir(), 'import-preview-'));
  });

  afterEach(() => {
    db.close();
    rmSync(vaultDir, { recursive: true, force: true });
  });

  function writeVault(relativePath: string, content: string): void {
    const fullPath = join(vaultDir, relativePath);
    mkdirSync(fullPath.split('/').slice(0, -1).join('/'), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  }

  it('reports files that would be created', async () => {
    writeVault('note1.md', '# Note 1\nContent one');
    writeVault('note2.md', '# Note 2\nContent two');

    const result = await previewImport(vaultDir, TENANT, deps);
    expect(result.fileCount).toBe(2);
    expect(result.wouldCreate).toBe(2);
    expect(result.wouldSkip).toBe(0);
  });

  it('reports collisions with existing memories', async () => {
    const content = 'Already curated content';
    const hash = computeContentHash(content);
    deps.memoryRepo.insert(makeCuratedMemory({ content, contentHash: hash }));

    writeVault('existing.md', content);
    writeVault('novel.md', 'Brand new content');

    const result = await previewImport(vaultDir, TENANT, deps);
    expect(result.wouldCreate).toBe(1);
    expect(result.wouldSkip).toBe(1);
    expect(result.files.find((f) => f.relativePath === 'existing.md')?.status).toBe('skipped');
  });

  it('strips frontmatter before collision check', async () => {
    const body = 'Unique body content here';
    writeVault('with-fm.md', `---\ntitle: My Title\n---\n\n${body}`);

    const result = await previewImport(vaultDir, TENANT, deps);
    expect(result.wouldCreate).toBe(1);
  });

  it('skips empty-body files', async () => {
    writeVault('empty-body.md', '---\ntitle: Just Frontmatter\n---\n');
    writeVault('real.md', 'Has content');

    const result = await previewImport(vaultDir, TENANT, deps);
    expect(result.wouldCreate).toBe(1);
    expect(result.wouldSkip).toBe(1);
  });

  it('detects intra-batch duplicates', async () => {
    writeVault('original.md', 'Same content');
    writeVault('copy.md', 'Same content');

    const result = await previewImport(vaultDir, TENANT, deps);
    expect(result.wouldCreate).toBe(1);
    expect(result.wouldSkip).toBe(1);
  });
});

describe('executeImport', () => {
  let db: Database.Database;
  let deps: ImportDependencies;
  let vaultDir: string;

  beforeEach(() => {
    db = createTestDatabase();
    deps = setupDeps(db);
    vaultDir = mkdtempSync(join(tmpdir(), 'import-exec-'));
  });

  afterEach(() => {
    db.close();
    rmSync(vaultDir, { recursive: true, force: true });
  });

  function writeVault(relativePath: string, content: string): void {
    const fullPath = join(vaultDir, relativePath);
    mkdirSync(fullPath.split('/').slice(0, -1).join('/'), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  }

  it('creates candidates and returns batch result', async () => {
    writeVault('note1.md', '# Note One\nFirst content');
    writeVault('note2.md', '# Note Two\nSecond content');

    const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    expect(result.fileCount).toBe(2);
    expect(result.createdCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.batchId).toBeTruthy();
  });

  it('creates an import batch record', async () => {
    writeVault('note.md', 'Content');

    const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    const batch = deps.batchRepo.findById(result.batchId);
    expect(batch).not.toBeNull();
    expect(batch!.status).toBe('completed');
    expect(batch!.fileCount).toBe(1);
    expect(batch!.createdCount).toBe(1);
  });

  it('uses frontmatter title when available', async () => {
    writeVault('note.md', '---\ntitle: Custom Title\n---\n\nBody content');

    const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    const candidateId = result.files[0]!.candidateId!;
    const candidate = deps.candidateRepo.findById(candidateId);
    expect(candidate!.title).toBe('Custom Title');
  });

  it('falls back to filename for title', async () => {
    writeVault('error-handling-guide.md', 'Content without frontmatter');

    const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    const candidateId = result.files[0]!.candidateId!;
    const candidate = deps.candidateRepo.findById(candidateId);
    expect(candidate!.title).toBe('Error Handling Guide');
  });

  it('maps frontmatter category to valid MemoryCategory', async () => {
    writeVault('decision.md', '---\ncategory: decision\n---\n\nWe decided X');

    const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    const candidate = deps.candidateRepo.findById(result.files[0]!.candidateId!)!;
    expect(candidate.category).toBe('decision');
  });

  it('defaults category to reference for invalid/missing category', async () => {
    writeVault('note.md', '---\ncategory: invalid_cat\n---\n\nContent');

    const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    const candidate = deps.candidateRepo.findById(result.files[0]!.candidateId!)!;
    expect(candidate.category).toBe('reference');
  });

  it('extracts tags from frontmatter', async () => {
    writeVault('tagged.md', '---\ntags: [api, patterns]\n---\n\nContent');

    const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    const candidate = deps.candidateRepo.findById(result.files[0]!.candidateId!)!;
    expect(candidate.metadata.tags).toEqual(['api', 'patterns']);
  });

  it('skips collisions and counts them', async () => {
    const body = 'Already exists';
    const hash = computeContentHash(body);
    deps.memoryRepo.insert(makeCuratedMemory({ content: body, contentHash: hash }));

    writeVault('dupe.md', body);
    writeVault('novel.md', 'New content');

    const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    expect(result.createdCount).toBe(1);
    expect(result.skippedCount).toBe(1);
  });

  it('handles empty vault gracefully', async () => {
    const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    expect(result.fileCount).toBe(0);
    expect(result.createdCount).toBe(0);
    const batch = deps.batchRepo.findById(result.batchId)!;
    expect(batch.status).toBe('completed');
  });

  it('strips frontmatter from content before storing', async () => {
    writeVault('note.md', '---\ntitle: My Title\ntags: [a]\n---\n\nJust the body');

    const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    const candidate = deps.candidateRepo.findById(result.files[0]!.candidateId!)!;
    expect(candidate.content).toBe('Just the body');
    expect(candidate.content).not.toContain('---');
  });

  // Epic 0 (compile-then-govern-c5k): the curator bulk-import path previously
  // bypassed the disclosure filter entirely — it called candidateRepo.insert()
  // directly with no PII / comp / secret check. The repository-layer choke point
  // now rejects disallowed content on this path too. A rejected file is recorded
  // as an error and never lands in the candidate table.
  describe('disclosure / secret choke point (bulk-import bypass path)', () => {
    it('rejects a vault file containing PII and never stores it', async () => {
      writeVault('clean.md', 'A perfectly clean technical note about caching');
      writeVault('pii.md', 'onboarding doc — applicant ssn 123-45-6789 recorded');

      const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
      expect(result.createdCount).toBe(1);
      expect(result.rejectedCount).toBe(1);
      // Only the clean candidate is in the store; the PII file was refused.
      expect(deps.candidateRepo.count()).toBe(1);
      const piiFile = result.files.find((f) => f.relativePath === 'pii.md');
      expect(piiFile?.status).toBe('error');
    });

    it('rejects a vault file containing compensation material', async () => {
      writeVault('comp.md', 'his base salary and 4-year vesting schedule leaked');

      const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
      expect(result.createdCount).toBe(0);
      expect(result.rejectedCount).toBe(1);
      expect(deps.candidateRepo.count()).toBe(0);
    });

    it('rejects a vault file containing a credential / secret', async () => {
      writeVault(
        'secret.md',
        'leftover token ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz12 in notes',
      );

      const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
      expect(result.createdCount).toBe(0);
      expect(result.rejectedCount).toBe(1);
      expect(deps.candidateRepo.count()).toBe(0);
    });

    it('does not leak the matched value into the per-file error reason', async () => {
      writeVault('pii.md', 'applicant ssn 123-45-6789 recorded');

      const result = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
      const piiFile = result.files.find((f) => f.relativePath === 'pii.md');
      expect(piiFile?.reason ?? '').not.toContain('123-45-6789');
    });
  });
});

describe('rollbackImport', () => {
  let db: Database.Database;
  let deps: ImportDependencies;
  let vaultDir: string;

  beforeEach(() => {
    db = createTestDatabase();
    deps = setupDeps(db);
    vaultDir = mkdtempSync(join(tmpdir(), 'import-rollback-'));
  });

  afterEach(() => {
    db.close();
    rmSync(vaultDir, { recursive: true, force: true });
  });

  function writeVault(relativePath: string, content: string): void {
    const fullPath = join(vaultDir, relativePath);
    mkdirSync(fullPath.split('/').slice(0, -1).join('/'), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  }

  it('deletes candidates created by the batch', async () => {
    writeVault('note1.md', 'Content one');
    writeVault('note2.md', 'Content two');

    const importResult = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    expect(deps.candidateRepo.count()).toBe(2);

    const rollbackResult = rollbackImport(importResult.batchId, deps, undefined, () => NOW);
    expect(rollbackResult.candidatesDeleted).toBe(2);
    expect(deps.candidateRepo.count()).toBe(0);
  });

  it('marks batch as rolled_back', async () => {
    writeVault('note.md', 'Content');

    const importResult = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    rollbackImport(importResult.batchId, deps, undefined, () => NOW);

    const batch = deps.batchRepo.findById(importResult.batchId)!;
    expect(batch.status).toBe('rolled_back');
    expect(batch.rolledBackAt).toBe(NOW);
  });

  it('throws for non-existent batch', () => {
    expect(() => rollbackImport('non-existent', deps)).toThrow('Import batch not found');
  });

  it('throws for already rolled-back batch', async () => {
    writeVault('note.md', 'Content');
    const importResult = await executeImport(vaultDir, TENANT, deps, undefined, () => NOW);
    rollbackImport(importResult.batchId, deps, undefined, () => NOW);

    expect(() => rollbackImport(importResult.batchId, deps, undefined, () => NOW)).toThrow(
      'already rolled back',
    );
  });
});
