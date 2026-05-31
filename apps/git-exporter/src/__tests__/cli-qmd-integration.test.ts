/**
 * Integration test for demo stages 5-6 (bead `qmd-team-intent-kb-e3q`):
 * curated memory → exporter-cli → real qmd index → search citation.
 *
 * This is the hermetic proof that the ICO → INTKB → qmd → citation chain
 * works end-to-end at the data plane, WITHOUT an ANTHROPIC_API_KEY: the
 * "content" is hand-crafted curated memories inserted straight into a
 * file-backed store, exactly the pattern the curator pipeline produces in
 * the live demo.
 *
 * It drives the REAL `qmd` binary (2.0.1+) with an isolated
 * XDG_CACHE_HOME so the test never touches the operator's personal qmd
 * index. The whole test is skipped if `qmd` is not on PATH (so CI without
 * qmd stays green) — but it runs locally + anywhere qmd is installed.
 *
 * Stage mapping:
 *   stage 5 → exporter-cli writes kb-export markdown + `qmd collection add` + `qmd update`
 *   stage 6 → `qmd search <keyword>` returns the curated memory's source path (the citation)
 *
 * @module __tests__/cli-qmd-integration.test
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CandidateRepository, MemoryRepository, createDatabase } from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../cli.js';

/** Detect qmd on PATH once; skip the suite if absent. */
function qmdAvailable(): boolean {
  try {
    execFileSync('qmd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_QMD = qmdAvailable();

let workDir: string;
let dbPath: string;
let exportDir: string;
let cacheDir: string;
let configDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'exporter-qmd-int-'));
  dbPath = join(workDir, 'teamkb.db');
  exportDir = join(workDir, 'kb-export');
  cacheDir = join(workDir, 'qmd-cache');
  configDir = join(workDir, 'qmd-config');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Run qmd FULLY isolated from the operator's real qmd state. Both XDG vars
 * are required: XDG_CACHE_HOME relocates the index (~/.cache/qmd/index.sqlite)
 * AND XDG_CONFIG_HOME relocates the collection registry
 * (~/.config/qmd/index.yml). Setting only the cache var would leak
 * `qmd collection add` entries into the operator's global registry.
 */
function qmd(args: string[]): string {
  return execFileSync('qmd', args, {
    encoding: 'utf8',
    env: { ...process.env, XDG_CACHE_HOME: cacheDir, XDG_CONFIG_HOME: configDir },
  });
}

/** Seed a file-backed store with curated memories (as the curator pipeline would). */
function seedStore(memories: ReturnType<typeof makeMemory>[]): void {
  const db = createDatabase({ path: dbPath });
  try {
    // CandidateRepository touch ensures the schema/migrations are applied
    // through the same path production uses; MemoryRepository writes the rows.
    new CandidateRepository(db);
    const memoryRepo = new MemoryRepository(db);
    for (const m of memories) memoryRepo.insert(m);
  } finally {
    (db as unknown as { close: () => void }).close();
  }
}

describe.skipIf(!HAS_QMD)(
  'demo stages 5-6: curated memory → exporter-cli → qmd search citation',
  () => {
    it('exports curated memories and finds them by keyword in qmd with a source citation', async () => {
      // --- Arrange: a curated memory whose content has a distinctive keyword ---
      const mem = makeMemory({
        title: 'Transformer attention mechanism',
        category: 'architecture', // → routed to curated/ by directory-mapper
        content:
          'The transformer attention mechanism computes scaled dot-product attention ' +
          'over query, key, and value matrices. Self-attention lets the model weigh ' +
          'sequence positions when producing each output representation.',
        tenantId: 'demo-e2e',
        metadata: { filePaths: ['wiki/topics/transformers.md'], tags: ['transformer'] },
      });
      seedStore([mem]);

      // --- Stage 5a: exporter-cli writes the kb-export markdown tree ---
      const rc = await dispatch(['export', '--db', dbPath, '--out', exportDir, '--json'], {
        createDb: ({ dbPath: p }) => createDatabase({ path: p ?? ':memory:' }),
      });
      expect(rc).toBe(0);

      // --- Stage 5b: register the export dir as a qmd collection + index it ---
      qmd(['collection', 'add', exportDir, '--name', 'kb-demo']);
      qmd(['update']);

      // --- Stage 6: search returns the curated memory with its source path ---
      const out = qmd(['search', 'attention']);
      // The qmd:// URI is the citation: collection name + the exported file path.
      expect(out).toMatch(/qmd:\/\/kb-demo\//);
      expect(out).toMatch(/attention/i);
    });

    it('keeps two tenants in separate exported trees (per-tenant isolation)', async () => {
      // Demonstrates the separation guarantee: filtering export by tenant only
      // materializes that tenant's memories, so an isolated qmd collection per
      // tenant contains only that tenant's content.
      seedStore([
        makeMemory({
          title: 'Braves scorecard rendering',
          category: 'architecture',
          content: 'Braves scorecard rendering uses a server-side pybaseball pipeline.',
          tenantId: 'braves',
        }),
        makeMemory({
          title: 'Trucking ELD compliance',
          category: 'reference',
          content: 'Trucking ELD compliance requires HOS logs retained for six months.',
          tenantId: 'trucking',
        }),
      ]);

      // Export ONLY the braves tenant.
      const rc = await dispatch(
        ['export', '--db', dbPath, '--out', exportDir, '--tenant', 'braves', '--json'],
        { createDb: ({ dbPath: p }) => createDatabase({ path: p ?? ':memory:' }) },
      );
      expect(rc).toBe(0);

      qmd(['collection', 'add', exportDir, '--name', 'kb-braves']);
      qmd(['update']);

      // The braves memory is findable...
      const bravesHit = qmd(['search', 'scorecard']);
      expect(bravesHit).toMatch(/qmd:\/\/kb-braves\//);

      // ...and the trucking memory is NOT in this tenant's index (it was never exported).
      const truckingHit = qmd(['search', 'ELD']);
      expect(truckingHit).not.toMatch(/Trucking ELD compliance/);
    });
  },
);
