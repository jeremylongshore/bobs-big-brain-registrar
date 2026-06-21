/**
 * Integration test for the PRODUCTION qmd-adapter against the real qmd binary
 * (bead `qmd-team-intent-kb-e3q`).
 *
 * This is the proof that the edge-daemon's `QmdAdapter` — not the demo's
 * direct-qmd sequence — actually indexes the git-exporter output tree and
 * returns curated memories with a `qmd://<collection>/...` citation. It closes
 * the original e3q root cause: the adapter used to register collections at a
 * per-tenant index path git-exporter never wrote to, and prepended a
 * `--data-dir` flag qmd 2.x does not have.
 *
 * What it exercises:
 *   - `ensureCollections()` registers each `kb-*` collection at
 *     `<exportDir>/<sourceSubdir>` (the git-exporter layout), mkdir'ing the
 *     subdirs first so empty categories register cleanly.
 *   - per-tenant XDG isolation via `getQmdTenantEnv` (no `--data-dir`).
 *   - `update()` indexes the real files.
 *   - `query()` parses qmd's `--json` output and surfaces the citation.
 *
 * Fully isolated: `TEAMKB_BASE_PATH` is repointed at a tmp dir so the tenant's
 * XDG_CONFIG_HOME / XDG_CACHE_HOME (and thus the qmd registry + index) live in
 * tmp and never touch the operator's personal `~/.config/qmd` / `~/.cache/qmd`.
 * Skipped entirely when qmd is not on PATH (keeps CI without qmd green).
 *
 * @module __tests__/adapter-qmd-integration.test
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { QmdAdapter } from '../adapter.js';

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
let exportDir: string;
let originalBasePath: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'qmd-adapter-int-'));
  exportDir = join(workDir, 'kb-export');
  // Repoint the team-KB base so getQmdTenantEnv → tmp XDG dirs (full isolation).
  originalBasePath = process.env['TEAMKB_BASE_PATH'];
  process.env['TEAMKB_BASE_PATH'] = join(workDir, 'teamkb');
});

afterEach(() => {
  if (originalBasePath === undefined) delete process.env['TEAMKB_BASE_PATH'];
  else process.env['TEAMKB_BASE_PATH'] = originalBasePath;
  rmSync(workDir, { recursive: true, force: true });
});

/** Write a markdown file into a git-exporter output subdir. */
function writeExport(subdir: string, name: string, body: string): void {
  const dir = join(exportDir, subdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, 'utf8');
}

describe.skipIf(!HAS_QMD)('QmdAdapter ↔ real qmd (production index path)', () => {
  it('indexes the git-exporter output tree and returns a kb-curated citation', async () => {
    // git-exporter writes an architecture memory into curated/
    writeExport(
      'curated',
      'transformers.md',
      '# Transformer attention mechanism\n\n' +
        'The transformer attention mechanism computes scaled dot-product attention ' +
        'over query, key, and value matrices. Self-attention lets the model weigh ' +
        'sequence positions when producing each output representation.\n',
    );

    const adapter = new QmdAdapter({ tenantId: 'demo-e2e', exportDir });

    const ensured = await adapter.ensureCollections();
    expect(ensured.ok).toBe(true);
    if (ensured.ok) {
      // kb-inbox has no exported source, so it is NOT registered
      expect(ensured.value).toEqual(['kb-curated', 'kb-decisions', 'kb-guides', 'kb-archive']);
    }

    const updated = await adapter.update();
    expect(updated.ok).toBe(true);

    // Name the bound tenant — the adapter is fail-closed on an omitted
    // tenantId (c5k.2), so an unscoped query would correctly return nothing.
    const found = await adapter.query('attention', 'curated', 'demo-e2e');
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.value.length).toBeGreaterThan(0);
      const hit = found.value.find((r) => r.collection === 'kb-curated');
      expect(hit).toBeDefined();
      // The qmd:// URI is the citation: collection name + exported file path.
      expect(hit!.file).toMatch(/qmd:\/\/kb-curated\/.*transformers\.md/);
    }
  }, 30000);

  it('isolates tenants: a second tenant does not see the first tenant content', async () => {
    writeExport(
      'curated',
      'transformers.md',
      '# Transformer attention\n\nScaled dot-product attention over query/key/value.\n',
    );

    // Tenant A indexes the export tree.
    const tenantA = new QmdAdapter({ tenantId: 'tenant-a', exportDir });
    expect((await tenantA.ensureCollections()).ok).toBe(true);
    expect((await tenantA.update()).ok).toBe(true);
    const aHit = await tenantA.query('attention', 'curated', 'tenant-a');
    expect(aHit.ok).toBe(true);
    if (aHit.ok) expect(aHit.value.length).toBeGreaterThan(0);

    // Tenant B has its own (empty) export tree + its own XDG dirs → finds nothing.
    const tenantBExport = join(workDir, 'kb-export-b');
    const tenantB = new QmdAdapter({ tenantId: 'tenant-b', exportDir: tenantBExport });
    expect((await tenantB.ensureCollections()).ok).toBe(true);
    expect((await tenantB.update()).ok).toBe(true);
    const bHit = await tenantB.query('attention', 'curated', 'tenant-b');
    expect(bHit.ok).toBe(true);
    if (bHit.ok) expect(bHit.value).toHaveLength(0);
  }, 30000);
});
