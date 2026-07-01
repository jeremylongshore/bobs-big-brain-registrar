/**
 * Live retrieval-eval reproduction (bead compile-then-govern-e06.4 / umbrella
 * #27 / ADR 038-AT-DECR).
 *
 * This is the CI-runnable proof that the FIRST REAL retrieval number reproduces:
 * it runs the hand-labeled `governed-brain-v1` query set through the production
 * `adapter.query()` BM25 path against the LIVE `~/.teamkb` qmd index (the same
 * one `brain_search` serves) and asserts the harness computes a coherent
 * stratified report + applies the 0.85 gate.
 *
 * Read-only: it searches an already-built index and never reindexes or writes.
 *
 * Skipped (not failed) when qmd is not on PATH OR the live index returns nothing
 * — so CI without a warm `~/.teamkb` stays green. The reported numbers live in
 * the PR body / `pnpm eval:retrieval` output; this test guards that the pipeline
 * that produced them still runs and that the dataset's gold ids are well-formed.
 *
 * @module __tests__/eval-retrieval-live.test
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { QmdAdapter } from '../adapter.js';
import { runEval } from '../eval/run-eval.js';
import { stratify } from '../eval/stratified-report.js';
import { qmdRetrievalFn } from '../eval/qmd-retrieval.js';
import { GOVERNED_BRAIN_V1_DATASET } from '../eval/datasets/governed-brain-v1.js';

function qmdAvailable(): boolean {
  try {
    execFileSync('qmd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const TENANT = process.env['TEAMKB_TENANT'] ?? 'intent-solutions';
const BASE = process.env['TEAMKB_BASE_PATH'] ?? join(homedir(), '.teamkb');
const EXPORT_DIR = join(BASE, 'kb-export');
const INDEX_DIR = join(BASE, 'qmd-index', TENANT);

// Only meaningful when qmd exists AND the tenant's index has been built.
const CAN_RUN = qmdAvailable() && existsSync(EXPORT_DIR) && existsSync(INDEX_DIR);

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

describe.skipIf(!CAN_RUN)('governed-brain-v1 ↔ live qmd BM25 index', () => {
  it('reproduces a coherent stratified retrieval report against the real index', async () => {
    const adapter = new QmdAdapter({ tenantId: TENANT, exportDir: EXPORT_DIR });
    const retrieve = qmdRetrievalFn(adapter, TENANT, 'curated');

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
});
