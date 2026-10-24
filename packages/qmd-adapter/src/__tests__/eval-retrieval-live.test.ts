/**
 * Live retrieval-eval reproduction (bead compile-then-govern-e06.4 / umbrella
 * #27 / ADR 038-AT-DECR).
 *
 * Explicitly configured live retrieval acceptance. Ordinary collection retains
 * only dataset integrity assertions and performs no qmd/index/operator probes.
 * The production adapter may initialize or refresh native/qmd sidecars: this is
 * a live state lane, not a filesystem-read-only or pure BM25 guarantee.
 * Missing explicitly requested configuration/index/binary fails rather than skips.
 *
 * @module __tests__/eval-retrieval-live.test
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { liveQmdArgs, liveTestEnabled, requireLiveSetting } from './live-test-config.js';

import { GOVERNED_BRAIN_V1_DATASET } from '../eval/datasets/governed-brain-v1.js';

describe('governed-brain-v1 dataset integrity', () => {
  it('has gold citations that are all well-formed qmd:// ids in default-searchable collections', () => {
    const allowed = /^qmd:\/\/kb-(curated|decisions|guides)\/[0-9a-f-]+\.md$/;
    for (const q of GOVERNED_BRAIN_V1_DATASET.queries) {
      expect(q.relevant.length, `query ${q.id} has no gold citation`).toBeGreaterThan(0);
      for (const cite of q.relevant) {
        expect(cite, `query ${q.id} gold id "${cite}" malformed`).toMatch(allowed);
      }
    }
  });

  it('is stratified with a semantic-weighted split (ADR 038 requires the semantic stratum)', () => {
    const kinds = GOVERNED_BRAIN_V1_DATASET.queries.map((q) => q.kind);
    const semantic = kinds.filter((k) => k === 'semantic').length;
    const lexical = kinds.filter((k) => k === 'lexical').length;
    expect(semantic).toBeGreaterThan(0);
    expect(lexical).toBeGreaterThan(0);
    // Weighted toward semantic — that's where the recall wall shows.
    expect(semantic).toBeGreaterThanOrEqual(lexical);
    expect(GOVERNED_BRAIN_V1_DATASET.queries.length).toBeGreaterThanOrEqual(30);
  });
});

describe.skipIf(!liveTestEnabled('RETRIEVAL'))(
  'governed-brain-v1 ↔ configured live retrieval index',
  () => {
    let tenant: string;
    let exportDir: string;
    let qmdBinary: string;
    let indexDir: string;
    let previousBase: string | undefined;
    let configured = false;
    beforeAll(() => {
      const base = requireLiveSetting('TEAMKB_TEST_LIVE_BASE_PATH');
      tenant = requireLiveSetting('TEAMKB_TEST_LIVE_TENANT_ID');
      qmdBinary = requireLiveSetting('TEAMKB_TEST_LIVE_QMD_BIN');
      if (!isAbsolute(base) || !isAbsolute(qmdBinary))
        throw new Error('Live base and qmd binary must be absolute paths');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(tenant)) throw new Error('Invalid live tenant');
      exportDir = join(base, 'kb-export');
      indexDir = join(base, 'qmd-index', tenant);
      if (!existsSync(exportDir) || !existsSync(indexDir))
        throw new Error('Configured live export/index is missing');
      execFileSync(qmdBinary, ['--version'], { stdio: 'ignore', timeout: 5_000 });
      previousBase = process.env['TEAMKB_BASE_PATH'];
      process.env['TEAMKB_BASE_PATH'] = base;
      configured = true;
    });
    afterAll(() => {
      if (!configured) return;
      if (previousBase === undefined) delete process.env['TEAMKB_BASE_PATH'];
      else process.env['TEAMKB_BASE_PATH'] = previousBase;
    });
    it('reproduces a coherent stratified retrieval report against the real index', async () => {
      const [{ QmdAdapter }, { runEval }, { stratify }, { qmdRetrievalFn }, { RealQmdExecutor }] =
        await Promise.all([
          import('../adapter.js'),
          import('../eval/run-eval.js'),
          import('../eval/stratified-report.js'),
          import('../eval/qmd-retrieval.js'),
          import('../executor/real-executor.js'),
        ]);
      const executor = new RealQmdExecutor({
        binary: qmdBinary,
        env: {
          XDG_CONFIG_HOME: join(indexDir, 'config'),
          XDG_CACHE_HOME: join(indexDir, 'cache'),
          INDEX_PATH: join(indexDir, 'cache', 'qmd', 'index.sqlite'),
          QMD_CONFIG_DIR: join(indexDir, 'config', 'qmd'),
        },
      });
      const adapter = new QmdAdapter(
        { tenantId: tenant, exportDir, qmdBinary },
        {
          execute: (args) => executor.execute(liveQmdArgs(args)),
          isAvailable: () => executor.isAvailable(),
        },
      );
      const retrieve = qmdRetrievalFn(adapter, tenant, 'curated');

      const report = await runEval(GOVERNED_BRAIN_V1_DATASET, retrieve, {
        k: 10,
        backend: 'qmd-bm25',
      });

      expect(report.queryCount).toBe(GOVERNED_BRAIN_V1_DATASET.queries.length);
      // The live index must actually answer at least some queries (else it's unbuilt).
      expect(report.perQuery.some((r) => r.retrieved.length > 0)).toBe(true);

      // Every retrieved id is a real qmd:// citation (the production id space).
      for (const r of report.perQuery) {
        for (const id of r.retrieved) {
          expect(id.startsWith('qmd://')).toBe(true);
        }
      }

      const sr = stratify(report, GOVERNED_BRAIN_V1_DATASET.queries);
      // Metrics are bounded [0,1] and the strata sum to the whole.
      expect(sr.overall.meanRecallAtK).toBeGreaterThanOrEqual(0);
      expect(sr.overall.meanRecallAtK).toBeLessThanOrEqual(1);
      expect(sr.overall.meanNdcgAtK).toBeGreaterThanOrEqual(0);
      expect(sr.overall.meanNdcgAtK).toBeLessThanOrEqual(1);
      const summed = sr.byKind.reduce((n, s) => n + s.queryCount, 0);
      expect(summed).toBe(report.queryCount);

      const semantic = sr.byKind.find((s) => s.stratum === 'semantic');
      expect(semantic).toBeDefined();
    }, 60000);
  },
);
