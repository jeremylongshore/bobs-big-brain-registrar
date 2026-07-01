#!/usr/bin/env tsx
/**
 * scripts/eval-retrieval.ts — the FIRST REAL retrieval number for the Governed
 * Second Brain (bead compile-then-govern-e06.4 / umbrella #27 / ADR 038-AT-DECR).
 *
 * Runs the hand-labeled `governed-brain-v1` query set through the LIVE qmd BM25
 * index via the production `adapter.query()` path (the same one `brain_search`
 * uses) and prints Recall@10 + nDCG@10 + MRR, OVERALL and split lexical vs
 * semantic, then the 0.85-Recall@10 BM25-sufficiency verdict from ADR 038.
 *
 * Read-only: it searches an already-built index (default `~/.teamkb`), never
 * reindexes, never writes to the brain. Run it after the index is fresh
 * (`pnpm reindex`) so search is warm.
 *
 * Usage:
 *   pnpm eval:retrieval                      # against ~/.teamkb, tenant intent-solutions
 *   TEAMKB_TENANT=<id> pnpm eval:retrieval   # different tenant
 *   TEAMKB_BASE_PATH=<dir> pnpm eval:retrieval   # different brain root
 *   EVAL_SCOPE=all pnpm eval:retrieval       # include inbox/archive (default: curated)
 *
 * Exit codes: 0 = ran and reported (regardless of verdict); 2 = qmd unavailable
 * or the index returned nothing for every query (misconfig — reindex first).
 */

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SearchScope } from '@qmd-team-intent-kb/schema';

import { QmdAdapter } from '../packages/qmd-adapter/src/adapter.js';
import {
  runEval,
  stratify,
  formatStratifiedReport,
  qmdRetrievalFn,
  BM25_SUFFICIENCY_RECALL_THRESHOLD,
  GOVERNED_BRAIN_V1_DATASET,
} from '../packages/qmd-adapter/src/eval/index.js';

function qmdAvailable(): boolean {
  try {
    execFileSync('qmd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!qmdAvailable()) {
    console.error(
      'qmd binary not on PATH — cannot run the live retrieval eval. Install qmd first.',
    );
    process.exit(2);
  }

  const tenantId = process.env['TEAMKB_TENANT'] ?? 'intent-solutions';
  const base = process.env['TEAMKB_BASE_PATH'] ?? join(homedir(), '.teamkb');
  const exportDir = join(base, 'kb-export');
  const scope = (process.env['EVAL_SCOPE'] as SearchScope | undefined) ?? 'curated';

  const adapter = new QmdAdapter({ tenantId, exportDir });
  const retrieve = qmdRetrievalFn(adapter, tenantId, scope);

  const dataset = GOVERNED_BRAIN_V1_DATASET;
  const report = await runEval(dataset, retrieve, { k: 10, backend: `qmd-bm25 (scope=${scope})` });

  // Guard: a totally empty result set means the index is not built for this
  // tenant, not that BM25 scored 0. Fail loudly instead of reporting a fake 0.
  const anyHits = report.perQuery.some((r) => r.retrieved.length > 0);
  if (!anyHits) {
    console.error(
      `Every query returned 0 hits for tenant "${tenantId}" at ${exportDir}. ` +
        'The qmd index is empty/unbuilt — run `pnpm reindex` first.',
    );
    process.exit(2);
  }

  const sr = stratify(report, dataset.queries);

  console.log(`\n=== Governed Second Brain — retrieval eval (${dataset.name}) ===`);
  console.log(`corpus: ${exportDir}  tenant: ${tenantId}  queries: ${report.queryCount}\n`);
  console.log(formatStratifiedReport(sr));

  const overall = sr.overall.meanRecallAtK;
  const semantic = sr.byKind.find((s) => s.stratum === 'semantic');
  const gate = BM25_SUFFICIENCY_RECALL_THRESHOLD;

  console.log(`\n=== ADR 038-AT-DECR verdict (gate: Recall@10 ≥ ${gate}) ===`);
  console.log(
    `overall Recall@10 = ${overall.toFixed(4)} → ${overall >= gate ? 'CLEARS' : 'BELOW'} the gate`,
  );
  if (semantic) {
    console.log(
      `semantic Recall@10 = ${semantic.meanRecallAtK.toFixed(4)} → ` +
        `${semantic.meanRecallAtK >= gate ? 'CLEARS' : 'BELOW'} the gate ` +
        '(the stratum ADR 038 weights the decision on)',
    );
  }
  console.log(
    overall >= gate
      ? '\nBM25 is SUFFICIENT — the ~320MB semantic backend (bead 0t9.3) is not yet justified.'
      : '\nBM25 is INSUFFICIENT on this set — the semantic recall wall is real; the sqlite-vec\n' +
          'semantic path (bead 0t9.3) is now justified per the ADR signal.',
  );

  // Machine-readable per-query dump for auditability (which queries BM25 missed).
  const misses = report.perQuery.filter((r) => r.recallAtK === 0);
  if (misses.length > 0) {
    console.log(`\n--- BM25 misses (Recall@10 = 0), ${misses.length} of ${report.queryCount} ---`);
    for (const m of misses) {
      console.log(`  [${m.kind ?? 'untagged'}] ${m.id}: "${m.query}"`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
