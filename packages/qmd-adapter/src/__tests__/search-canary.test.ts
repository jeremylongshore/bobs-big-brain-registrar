import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockQmdExecutor } from '../executor/mock-executor.js';
import { QmdAdapter } from '../adapter.js';
import {
  runSearchCanary,
  formatCanaryReport,
  DEFAULT_CANARY_CONTROLS,
} from '../canary/search-canary.js';

const TENANT = 'test-tenant';

/** A qmd `search --json` payload with `n` synthetic hits. */
function hitsJson(n: number): string {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      score: 0.9,
      file: `qmd://kb-curated/doc-${i}.md`,
      snippet: `snippet ${i}`,
    })),
  );
}

describe('runSearchCanary', () => {
  let mock: MockQmdExecutor;
  let adapter: QmdAdapter;
  let exportDir: string;

  beforeEach(() => {
    mock = new MockQmdExecutor();
    exportDir = mkdtempSync(join(tmpdir(), 'qmd-canary-test-'));
    adapter = new QmdAdapter({ tenantId: TENANT, exportDir }, mock);
  });

  afterEach(() => {
    rmSync(exportDir, { recursive: true, force: true });
  });

  it('is HEALTHY when every control returns hits', async () => {
    // One search per default control, each with hits.
    for (const _ of DEFAULT_CANARY_CONTROLS) mock.queueSuccess(hitsJson(3));

    const report = await runSearchCanary(adapter, TENANT);

    expect(report.healthy).toBe(true);
    expect(report.controls).toHaveLength(DEFAULT_CANARY_CONTROLS.length);
    expect(report.controls.every((c) => c.passed)).toBe(true);
  });

  it('is DEGRADED (the incident) when any control returns 0 hits', async () => {
    // First control OK, second returns an empty array (0 hits), third OK.
    mock.queueSuccess(hitsJson(2));
    mock.queueSuccess(hitsJson(0)); // <- the "SEARCH DEGRADED" signal
    mock.queueSuccess(hitsJson(2));

    const report = await runSearchCanary(adapter, TENANT);

    expect(report.healthy).toBe(false);
    const failing = report.controls.filter((c) => !c.passed);
    expect(failing).toHaveLength(1);
    expect(failing[0]?.hits).toBe(0);
  });

  it('captures a failed search command per-control without throwing', async () => {
    mock.queueSuccess(hitsJson(1));
    mock.queueFailure('qmd exploded'); // second control's search fails
    mock.queueSuccess(hitsJson(1));

    const report = await runSearchCanary(adapter, TENANT);

    expect(report.healthy).toBe(false);
    const errored = report.controls.find((c) => c.error !== undefined);
    expect(errored?.passed).toBe(false);
    expect(errored?.error?.code).toBe('command_failed');
  });

  it('honors a custom minHits threshold', async () => {
    const report = await (async () => {
      mock.queueSuccess(hitsJson(1)); // 1 hit
      return runSearchCanary(adapter, TENANT, {
        controls: [{ query: 'needs at least two', minHits: 2 }],
      });
    })();

    expect(report.healthy).toBe(false);
    expect(report.controls[0]?.hits).toBe(1);
    expect(report.controls[0]?.minHits).toBe(2);
  });

  it('respects a tenant mismatch (fail-closed) as a degraded signal', async () => {
    // No mock responses queued: adapter.query short-circuits to [] on mismatch,
    // never touching the executor — so every control reads as 0 hits.
    const report = await runSearchCanary(adapter, 'WRONG-tenant', {
      controls: [{ query: 'anything' }],
    });

    expect(report.healthy).toBe(false);
    expect(report.controls[0]?.hits).toBe(0);
    expect(mock.commands).toHaveLength(0);
  });

  describe('heal', () => {
    it('reindexes on failure then re-checks, going green if the heal fixes it', async () => {
      const controls = [{ query: 'audit chain receipts' }];

      // Pass 1: empty index -> 0 hits (degraded).
      mock.queueSuccess(hitsJson(0));
      // Heal: reindex = ensureCollections (list + 4 adds) + update.
      mock.queueSuccess(''); // collection list
      for (let i = 0; i < 4; i++) mock.queueSuccess(''); // 4 adds
      mock.queueSuccess('Updated'); // update
      // Pass 2 (re-check): now returns hits.
      mock.queueSuccess(hitsJson(5));

      const report = await runSearchCanary(adapter, TENANT, { controls, heal: true });

      expect(report.healthy).toBe(true);
      expect(report.healed).toEqual({ attempted: true, reindexOk: true, recheckHealthy: true });
      expect(report.controls[0]?.hits).toBe(5);
    });

    it('stays degraded when the heal cannot fix it', async () => {
      const controls = [{ query: 'audit chain receipts' }];

      mock.queueSuccess(hitsJson(0)); // pass 1: degraded
      mock.queueSuccess(''); // heal: list
      for (let i = 0; i < 4; i++) mock.queueSuccess(''); // adds
      mock.queueSuccess('Updated'); // update
      mock.queueSuccess(hitsJson(0)); // pass 2: STILL 0 hits (e.g. empty kb-export)

      const report = await runSearchCanary(adapter, TENANT, { controls, heal: true });

      expect(report.healthy).toBe(false);
      expect(report.healed?.recheckHealthy).toBe(false);
    });
  });
});

describe('formatCanaryReport', () => {
  it('labels a healthy report', () => {
    const out = formatCanaryReport({
      healthy: true,
      tenantId: 'intent-solutions',
      controls: [{ query: 'audit chain receipts', minHits: 1, hits: 20, passed: true }],
    });
    expect(out).toContain('SEARCH HEALTHY');
    expect(out).toContain('[OK ]');
    expect(out).toContain('20 hits');
  });

  it('labels a degraded report with the failing control', () => {
    const out = formatCanaryReport({
      healthy: false,
      tenantId: 'local',
      controls: [{ query: 'governed brain backup', minHits: 1, hits: 0, passed: false }],
    });
    expect(out).toContain('SEARCH DEGRADED');
    expect(out).toContain('[FAIL]');
    expect(out).toContain('0 hits');
  });
});
