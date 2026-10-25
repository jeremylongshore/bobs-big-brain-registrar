/**
 * Live retrieval-eval reproduction (bead compile-then-govern-e06.4 / umbrella
 * #27 / ADR 038-AT-DECR).
 *
 * Explicit retrieval acceptance over a disposable copy of configured exports.
 * Rebuild derived native/qmd indexes inside an owned worker; source indexes and
 * state databases are not opened. This measures the copied corpus, not a bitwise
 * reproduction of its existing live index or a pure BM25 guarantee.
 * Ordinary collection retains only dataset integrity assertions and performs no
 * qmd/index/operator probes. Missing explicit configuration fails rather than skips.
 *
 * @module __tests__/eval-retrieval-live.test
 */

import { isAbsolute } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { liveTestEnabled, requireLiveSetting } from './live-test-config.js';

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
  'governed-brain-v1 ↔ disposable copied-corpus retrieval',
  () => {
    let sourceBase: string;
    let tenant: string;
    let qmdBinary: string;
    beforeAll(() => {
      sourceBase = requireLiveSetting('TEAMKB_TEST_LIVE_BASE_PATH');
      tenant = requireLiveSetting('TEAMKB_TEST_LIVE_TENANT_ID');
      qmdBinary = requireLiveSetting('TEAMKB_TEST_LIVE_QMD_BIN');
      if (!isAbsolute(sourceBase) || !isAbsolute(qmdBinary))
        throw new Error('Live source base and qmd binary must be absolute paths');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(tenant)) throw new Error('Invalid live tenant');
    });
    it('rebuilds a disposable copied corpus and returns a coherent stratified report', async () => {
      const { runCopiedRetrieval } = await import('./live-retrieval-copy.js');
      const {
        report,
        stratified: sr,
        copiedFiles,
        copiedBytes,
      } = await runCopiedRetrieval({
        sourceBase,
        tenantId: tenant,
        qmdBinary,
      });
      expect(copiedFiles).toBeGreaterThan(0);
      expect(copiedBytes).toBeGreaterThan(0);

      expect(report.queryCount).toBe(GOVERNED_BRAIN_V1_DATASET.queries.length);
      // The rebuilt copy must actually answer some queries (else it is unbuilt).
      expect(report.perQuery.some((r) => r.retrieved.length > 0)).toBe(true);

      // Every retrieved id is a real qmd:// citation (the production id space).
      for (const r of report.perQuery) {
        for (const id of r.retrieved) {
          expect(id.startsWith('qmd://')).toBe(true);
        }
      }

      // Metrics are bounded [0,1] and the strata sum to the whole.
      expect(sr.overall.meanRecallAtK).toBeGreaterThanOrEqual(0);
      expect(sr.overall.meanRecallAtK).toBeLessThanOrEqual(1);
      expect(sr.overall.meanNdcgAtK).toBeGreaterThanOrEqual(0);
      expect(sr.overall.meanNdcgAtK).toBeLessThanOrEqual(1);
      const summed = sr.byKind.reduce((n, s) => n + s.queryCount, 0);
      expect(summed).toBe(report.queryCount);

      const semantic = sr.byKind.find((s) => s.stratum === 'semantic');
      expect(semantic).toBeDefined();
      // Fresh copied-corpus indexing is bounded by the helper's 120 s budget.
    }, 150000);
  },
);
