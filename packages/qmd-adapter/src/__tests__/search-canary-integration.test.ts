/**
 * Integration test: the search-health canary + reindex against the REAL qmd
 * binary (bead compile-then-govern-e06.13 / risk register R11 / umbrella #27).
 *
 * This is the CI-runnable proof of the whole "never silently degrade again"
 * loop, exercised end-to-end against real qmd (not a mock):
 *
 *   1. An empty/unregistered tenant → the canary is DEGRADED (0 hits on every
 *      known-positive control). This is the exact "SEARCH DEGRADED" incident
 *      the canary exists to catch loudly.
 *   2. `reindex()` (ensureCollections + update) rebuilds the derived index from
 *      the kb-export tree — idempotently, touching no source-of-truth.
 *   3. After the reindex, the canary is HEALTHY (the controls now return hits
 *      with real `qmd://` citations).
 *   4. `--heal`-style flow: `runSearchCanary(..., { heal: true })` against a
 *      still-empty tenant self-repairs from kb-export and goes green in one call.
 *
 * Fully isolated exactly like adapter-qmd-integration.test.ts: `TEAMKB_BASE_PATH`
 * is repointed at a tmp dir so the tenant's XDG_CONFIG_HOME / XDG_CACHE_HOME (the
 * qmd registry + index) live in tmp and never touch the operator's personal qmd
 * state. Skipped when qmd is not on PATH so CI without qmd stays green.
 *
 * @module __tests__/search-canary-integration.test
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { QmdAdapter } from '../adapter.js';
import { reindex } from '../reindex/reindex.js';
import { runSearchCanary } from '../canary/search-canary.js';

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
  workDir = mkdtempSync(join(tmpdir(), 'qmd-canary-int-'));
  exportDir = join(workDir, 'kb-export');
  originalBasePath = process.env['TEAMKB_BASE_PATH'];
  process.env['TEAMKB_BASE_PATH'] = join(workDir, 'teamkb');
});

afterEach(() => {
  if (originalBasePath === undefined) delete process.env['TEAMKB_BASE_PATH'];
  else process.env['TEAMKB_BASE_PATH'] = originalBasePath;
  rmSync(workDir, { recursive: true, force: true });
});

/** Seed curated markdown that answers all three default control queries. */
function seedCorpus(): void {
  const dir = join(exportDir, 'curated');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'receipts.md'),
    '# Audit chain receipts\n\n' +
      'The governed brain keeps a hash-chained audit trail of cryptographic ' +
      'receipts. This is the backup and DR record for the compile then govern ' +
      'architecture.\n',
    'utf8',
  );
}

// Controls scoped to only the seeded doc's themes.
const CONTROLS = [
  { query: 'audit chain receipts' },
  { query: 'governed brain backup' },
  { query: 'compile then govern architecture' },
];

describe.skipIf(!HAS_QMD)('search-health canary ↔ real qmd', () => {
  it('is DEGRADED on an empty/unregistered tenant (the incident)', async () => {
    seedCorpus(); // corpus exists on disk, but the tenant index is not built yet
    const adapter = new QmdAdapter({ tenantId: 'canary-empty', exportDir });

    const report = await runSearchCanary(adapter, 'canary-empty', { controls: CONTROLS });

    expect(report.healthy).toBe(false);
    expect(report.controls.every((c) => c.hits === 0)).toBe(true);
  }, 30000);

  it('reindex() rebuilds the index → canary goes HEALTHY with cited hits', async () => {
    seedCorpus();
    const adapter = new QmdAdapter({ tenantId: 'canary-rebuild', exportDir });

    // BEFORE: degraded.
    const before = await runSearchCanary(adapter, 'canary-rebuild', { controls: CONTROLS });
    expect(before.healthy).toBe(false);

    // Rebuild the derived index.
    const rebuilt = await reindex(adapter);
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) {
      expect(rebuilt.value.collectionsCreated).toContain('kb-curated');
      expect(rebuilt.value.indexUpdated).toBe(true);
    }

    // AFTER: healthy, and the hits carry real qmd:// citations.
    const after = await runSearchCanary(adapter, 'canary-rebuild', { controls: CONTROLS });
    expect(after.healthy).toBe(true);
    expect(after.controls.every((c) => c.hits >= 1)).toBe(true);

    const cited = await adapter.query('audit chain receipts', 'all', 'canary-rebuild');
    expect(cited.ok).toBe(true);
    if (cited.ok) {
      expect(cited.value.some((r) => r.file.startsWith('qmd://'))).toBe(true);
    }
  }, 30000);

  it('is idempotent — a second reindex creates no collections and stays healthy', async () => {
    seedCorpus();
    const adapter = new QmdAdapter({ tenantId: 'canary-idem', exportDir });

    const first = await reindex(adapter);
    expect(first.ok).toBe(true);

    const second = await reindex(adapter);
    expect(second.ok).toBe(true);
    if (second.ok) {
      // Nothing new to register on the re-run — the idempotency signal.
      expect(second.value.collectionsCreated).toEqual([]);
    }

    const report = await runSearchCanary(adapter, 'canary-idem', { controls: CONTROLS });
    expect(report.healthy).toBe(true);
  }, 30000);

  it('--heal self-repairs an empty tenant from kb-export in one call', async () => {
    seedCorpus();
    const adapter = new QmdAdapter({ tenantId: 'canary-heal', exportDir });

    const report = await runSearchCanary(adapter, 'canary-heal', {
      controls: CONTROLS,
      heal: true,
    });

    expect(report.healthy).toBe(true);
    expect(report.healed).toEqual({ attempted: true, reindexOk: true, recheckHealthy: true });
  }, 30000);
});
