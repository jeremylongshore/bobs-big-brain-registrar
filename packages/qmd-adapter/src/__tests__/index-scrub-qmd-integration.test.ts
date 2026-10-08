/**
 * Index scrub against indexes built by the REAL pinned qmd binary (bead
 * 39z.19). CI puts the workspace `@tobilu/qmd` on PATH, so this runs there;
 * it is skipped only where no qmd binary exists.
 *
 * It reproduces the live finding of 2026-10-04 with qmd's own code paths:
 *   - tenant `intent-solutions` is reindexed after the redacted memory moved
 *     from curated/ to archive/, so qmd soft-deletes the old row (`active = 0`)
 *     and KEEPS its content row — the old text survives a reindex;
 *   - tenant `local` is never reindexed, so it still serves the old row.
 * It also proves the recorded schema matches what this qmd version writes.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { QmdAdapter } from '../adapter.js';
import { scrubIndexes } from '../scrub/index-scrub.js';
import { QMD_INDEX_SCHEMA, checkSchema } from '../scrub/schema-guard.js';
import {
  LEAKED,
  MEMORY_A,
  MEMORY_B,
  REDACTED,
  SECRET,
  SURVIVOR,
  SURVIVOR_TERM,
  buildNative,
  filesContaining,
  writeExport,
} from './index-scrub-fixtures.js';

function qmdAvailable(): boolean {
  try {
    execFileSync('qmd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_QMD = qmdAvailable();

let work: string;
let exportDir: string;
let indexDir: string;
let originalBase: string | undefined;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'index-scrub-qmd-'));
  exportDir = join(work, 'kb-export');
  indexDir = join(work, 'teamkb', 'qmd-index');
  originalBase = process.env['TEAMKB_BASE_PATH'];
  process.env['TEAMKB_BASE_PATH'] = join(work, 'teamkb');
});

afterEach(() => {
  if (originalBase === undefined) delete process.env['TEAMKB_BASE_PATH'];
  else process.env['TEAMKB_BASE_PATH'] = originalBase;
  rmSync(work, { recursive: true, force: true });
});

async function qmdIndex(tenantId: string): Promise<QmdAdapter> {
  const adapter = new QmdAdapter({ tenantId, exportDir, disableNativeFusion: true });
  expect((await adapter.ensureCollections()).ok).toBe(true);
  expect((await adapter.update()).ok).toBe(true);
  return adapter;
}

describe.skipIf(!HAS_QMD)('index scrub ↔ real qmd index (two tenants)', () => {
  it('removes the old text qmd keeps after a reindex, in every tenant, and search still works', async () => {
    writeExport(exportDir, 'curated', `${MEMORY_A}.md`, LEAKED);
    writeExport(exportDir, 'curated', `${MEMORY_B}.md`, SURVIVOR);
    const main = await qmdIndex('intent-solutions');
    const local = await qmdIndex('local');
    buildNative(join(indexDir, 'local', 'native-fts5.sqlite'), exportDir);

    const real = new Database(join(indexDir, 'local', 'cache', 'qmd', 'index.sqlite'), {
      readonly: true,
    });
    expect(checkSchema(real, QMD_INDEX_SCHEMA)).toEqual([]);
    real.close();

    // Redact + move to archive (what exporter --reconcile writes), then reindex
    // ONLY the API tenant — the live sequence.
    unlinkSync(join(exportDir, 'curated', `${MEMORY_A}.md`));
    writeExport(exportDir, 'archive', `${MEMORY_A}.md`, REDACTED);
    expect((await main.update()).ok).toBe(true);

    const before = filesContaining(indexDir, SECRET);
    expect(before.some((f) => f.startsWith('intent-solutions/cache/qmd/index.sqlite'))).toBe(true);
    expect(before.some((f) => f.startsWith('local/cache/qmd/index.sqlite'))).toBe(true);

    const report = scrubIndexes({ indexDir, exportDir, fragments: [SECRET] });
    expect(report.complete).toBe(true);
    const qmdFile = (tenant: string) =>
      report.tenants.find((t) => t.tenant === tenant)!.files.find((f) => f.kind === 'qmd')!;
    expect(qmdFile('intent-solutions').removed.inactiveDocuments).toBe(1);
    expect(qmdFile('local').removed.staleDocuments).toBe(1);
    expect(filesContaining(indexDir, SECRET)).toEqual([]);

    // qmd itself still serves the survivor from the scrubbed caches.
    for (const [tenant, adapter] of [
      ['intent-solutions', main],
      ['local', local],
    ] as const) {
      const hits = await adapter.query(SURVIVOR_TERM, 'curated', tenant);
      expect(hits.ok).toBe(true);
      if (hits.ok) expect(hits.value.map((h) => h.file).join(' ')).toContain(MEMORY_B);
    }
    // …and the next qmd update after a scrub is a clean no-op on the kept rows.
    expect((await main.update()).ok).toBe(true);
    expect(filesContaining(indexDir, SECRET)).toEqual([]);
  }, 60_000);
});
