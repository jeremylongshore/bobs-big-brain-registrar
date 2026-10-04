import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestDatabase,
  MemoryRepository,
  ExportStateRepository,
} from '@qmd-team-intent-kb/store';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runExport } from '../exporter.js';
import { makeCuratedMemory, LATER, TENANT } from './fixtures.js';

/**
 * Governed redaction at the export boundary (Epic K bead K3).
 *
 * A redaction rewrites the memory row. The exported Markdown file is a COPY,
 * so the old text stays on disk until the exporter runs in reconcile mode —
 * which content-compares and rewrites. No exporter code changed for K3; these
 * tests pin the behavior the redaction runbook depends on. The secret-shaped
 * value is synthetic.
 */
const SECRET = 'zq' + 'Synth' + 'Export' + '9Vb3Nc7Xk1Mq';
const ORIGINAL = `Cutover notes. The account passphrase we set is ${SECRET} for now.`;
const REDACTED = 'Cutover notes. [REDACTED]';

describe('runExport — after a governed redaction', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let exportStateRepo: ExportStateRepository;
  let out: string;

  const cfg = (reconcile: boolean) => ({
    outputDir: out,
    targetId: 'kb-export-default',
    tenantId: TENANT,
    reconcile,
  });

  /** Full text of every file under the export tree. */
  function treeText(): string {
    return ['decisions', 'curated', 'guides', 'archive', 'bulk']
      .flatMap((d) => {
        const dir = join(out, d);
        if (!existsSync(dir)) return [];
        return readdirSync(dir).map((f: string) => readFileSync(join(dir, f), 'utf8'));
      })
      .join('\n');
  }

  /** Apply what a redaction does to the row: new content, new hash, bumped version. */
  function redact(memory: ReturnType<typeof makeCuratedMemory>): void {
    memoryRepo.update({
      ...memory,
      content: REDACTED,
      contentHash: computeContentHash(REDACTED),
      updatedAt: LATER,
      version: memory.version + 1,
    });
  }

  beforeEach(() => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    exportStateRepo = new ExportStateRepository(db);
    out = mkdtempSync(join(tmpdir(), 'git-exporter-redaction-'));
  });
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
    db.close();
  });

  it.each(['active', 'archived'] as const)(
    'reconcile rewrites the exported file of a redacted %s memory',
    (lifecycle) => {
      const memory = makeCuratedMemory({ content: ORIGINAL, lifecycle });
      memoryRepo.insert(memory);
      runExport(memoryRepo, exportStateRepo, cfg(true));
      expect(treeText()).toContain(SECRET);

      redact(memory);
      // Until the exporter runs, the exported copy still holds the old text.
      expect(treeText()).toContain(SECRET);

      runExport(memoryRepo, exportStateRepo, cfg(true));
      const after = treeText();
      expect(after).not.toContain(SECRET);
      expect(after).toContain('[REDACTED]');
      expect(after).toContain(computeContentHash(REDACTED));
    },
  );

  it('a second reconcile after the rewrite is a clean no-op', () => {
    const memory = makeCuratedMemory({ content: ORIGINAL });
    memoryRepo.insert(memory);
    runExport(memoryRepo, exportStateRepo, cfg(true));
    redact(memory);
    runExport(memoryRepo, exportStateRepo, cfg(true));
    const before = treeText();

    const again = runExport(memoryRepo, exportStateRepo, cfg(true));
    expect(again.written).toHaveLength(0);
    expect(again.removed).toHaveLength(0);
    expect(treeText()).toBe(before);
  });
});
