#!/usr/bin/env tsx
/**
 * scripts/eval-estate-onboarding.ts — forgetting-aware retrieval eval over the
 * questions a new hire asks (bead compile-then-govern-39z.5).
 *
 * Recall@10 scores the brain fine while it still recommends a platform torn down
 * on 2026-07-09. This runs `estate-onboarding-v1` through the local
 * QmdAdapter/SearchService retrieval core with temporary index snapshots and
 * the current export tree. It does not exercise the deployed HTTP API, auth or
 * middleware. It reports Recall@10 next to FAMA@10, which
 * subtracts for every labeled-obsolete doc that makes the top 10.
 *
 * The launcher snapshots the store and retrieval indexes before this worker runs.
 * Native refresh and dense initialization write only to temporary copies.
 * Exported markdown is read from the original tree. Point it at another brain with
 * TEAMKB_BASE_PATH. Unlike the governed-brain-v1 anchor this is NOT frozen: the
 * point is to measure local current-source retrieval, not deployed-service acceptance.
 *
 * Usage:
 *   pnpm eval:estate                               # score the dataset
 *   pnpm eval:estate --json                        # machine-readable report
 *   pnpm eval:estate --probe "how do I deploy"     # top-10 with lifecycle, for labeling
 *
 * Exit codes: 0 = ran and reported (regardless of score); 2 = store or qmd
 * unavailable, or every query came back empty (unbuilt index, not a score of 0).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createDatabase, MemoryRepository } from '@qmd-team-intent-kb/store';
import { QmdAdapter } from '../packages/qmd-adapter/src/adapter.js';
import { getDefaultDenseConfig, getQmdTenantEnv } from '../packages/qmd-adapter/src/config.js';
import { RealQmdExecutor } from '../packages/qmd-adapter/src/executor/real-executor.js';
import {
  runEval,
  formatReport,
  ESTATE_ONBOARDING_V1_DATASET,
  ESTATE_ONBOARDING_V1_GAPS,
} from '../packages/qmd-adapter/src/eval/index.js';
import type { RetrievalFn, RetrievalContext } from '../packages/qmd-adapter/src/eval/index.js';
import { SearchService } from '../apps/api/src/services/search-service.js';
import { EstateDenseDiagnostics } from './lib/estate-eval-diagnostics.js';

const K = 10;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tenantId = process.env['TEAMKB_TENANT'] ?? 'intent-solutions';
  const base = process.env['TEAMKB_BASE_PATH'] ?? join(homedir(), '.teamkb');
  const dbPath = join(base, 'teamkb.db');
  const exportDir = process.env['TEAMKB_EVAL_EXPORT_DIR'];
  if (exportDir === undefined) throw new Error('Run eval:estate through its isolated launcher');
  if (!existsSync(dbPath)) {
    console.error(`no store at ${dbPath}`);
    process.exit(2);
  }

  const db = createDatabase({ path: dbPath, readonly: true });
  const memoryRepo = new MemoryRepository(db);
  // Count dense-arm degradations: production fails open to lexical-only without
  // a word, which is how a stopped embedder went unnoticed 2026-10-10..13. A
  // report must say which retrieval it measured.
  const dense = getDefaultDenseConfig();
  const diagnostics = new EstateDenseDiagnostics();
  const denseFailureCategories = diagnostics.categories;
  const executor = new RealQmdExecutor({ env: getQmdTenantEnv(tenantId) });
  const adapter = new QmdAdapter(
    {
      tenantId,
      exportDir,
      dense: {
        ...dense,
        onQueryDegraded: (reason) => {
          diagnostics.observe(reason);
        },
      },
    },
    {
      // Explicit index prevents qmd from auto-discovering a project-local .qmd
      // registry in any ancestor of the temporary worker directory.
      execute: (args) => executor.execute(['--index', 'index', ...args]),
      isAvailable: async () =>
        (await executor.execute(['--index', 'index', '--version'])).exitCode === 0,
    },
  );
  const health = await adapter.health();
  if (!health.available) {
    console.error('qmd unavailable — cannot run the live estate eval');
    process.exit(2);
  }
  const search = new SearchService(memoryRepo, adapter);
  const ask = async (q: string, context?: RetrievalContext) =>
    diagnostics.run(
      context,
      async () =>
        (
          await search.search(
            { query: q, scope: 'curated', tenantId, pagination: { page: 1, pageSize: K } },
            'member', // a new hire's standing
          )
        ).hits,
    );

  const snapshot = JSON.parse(process.env['TEAMKB_EVAL_SNAPSHOT'] ?? '{}') as {
    indexes?: { qmd?: boolean; native?: boolean; dense?: boolean };
    startedAt?: string;
    completedAt?: string;
  };
  const mode = () => {
    const denseMode = !dense.enabled
      ? 'lexical only (TEAMKB_DENSE_ENABLED off)'
      : snapshot.indexes?.dense !== true
        ? 'DEGRADED: dense index missing in source snapshot'
        : diagnostics.total > 0
          ? `DEGRADED: dense arm failed ${diagnostics.total} time(s) (${Object.entries(
              denseFailureCategories,
            )
              .map(([name, count]) => `${name}:${count}`)
              .join(', ')})`
          : 'dense + lexical (dense query failures observed: 0)';
    return (
      `${denseMode}; qmd snapshot ${snapshot.indexes?.qmd === true ? 'present' : 'missing'}; ` +
      `native snapshot ${snapshot.indexes?.native === true ? 'present' : 'missing (refresh permitted only in isolation)'}`
    );
  };
  const isolation = {
    mode: 'temporary database/index snapshots; original export tree read only',
    sourceIndexes: snapshot.indexes,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    // Each SQLite backup is consistent, but concurrent writers can make the
    // independent snapshots and original export tree represent different times.
    atomicAcrossSources: false,
    sourceSqliteCoordination:
      'readonly backup may create empty WAL/SHM files and update SHM reader marks',
  };

  const probeAt = args.indexOf('--probe');
  if (probeAt !== -1) {
    for (const [probeIndex, q] of args.slice(probeAt + 1).entries()) {
      console.log(`\n=== ${q}`);
      for (const [i, hit] of (
        await ask(q, { phase: 'probe', queryId: `probe-${probeIndex + 1}` })
      ).entries()) {
        const m = hit.memoryId === undefined ? null : memoryRepo.findById(hit.memoryId);
        console.log(
          `${String(i + 1).padStart(2)}. ${hit.citation}  [${m?.lifecycle ?? '?'} · ${m?.category ?? '?'} · ` +
            `${m?.updatedAt.slice(0, 10) ?? '?'}]  ${m?.title ?? hit.title}`,
        );
      }
    }
    console.log(`\nretrieval: ${mode()}`);
    console.log(
      JSON.stringify({
        denseFailureEvents: diagnostics.events,
        denseFailureEventsDropped: diagnostics.droppedEvents,
      }),
    );
    console.log(`isolation: ${isolation.mode}; not an atomic corpus snapshot`);
    console.log(`SQLite coordination: ${isolation.sourceSqliteCoordination}`);
    return;
  }

  const retrieve: RetrievalFn = async (q, k, context) =>
    (await ask(q, context)).slice(0, k).map((h) => h.citation ?? '');
  const dataset = ESTATE_ONBOARDING_V1_DATASET;
  const report = await runEval(dataset, retrieve, {
    k: K,
    backend: 'local SearchService retrieval',
  });
  if (!report.perQuery.some((r) => r.retrieved.length > 0)) {
    console.error(`every query returned 0 hits for tenant "${tenantId}" — index unbuilt?`);
    process.exit(2);
  }

  // Holes filled since labeling: where the answer now ranks (1-based, null = not in the top K).
  // Reported, not scored, so the scored set stays comparable across runs.
  const gaps = [];
  for (const g of ESTATE_ONBOARDING_V1_GAPS) {
    const answeredBy = g.answeredBy ?? [];
    let answerRank: number | null = null;
    if (answeredBy.length > 0) {
      const got = await retrieve(g.query, K, { phase: 'gap', queryId: g.id });
      const ranks = answeredBy.map((c) => got.indexOf(c)).filter((i) => i >= 0);
      answerRank = ranks.length > 0 ? Math.min(...ranks) + 1 : null;
    }
    gaps.push({ ...g, answerRank });
  }

  report.backend = `local SearchService retrieval · ${mode()}`;
  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          ...report,
          gaps,
          isolation,
          denseFailureCategories,
          denseFailureEvents: diagnostics.events,
          denseFailureEventsDropped: diagnostics.droppedEvents,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n=== Estate onboarding — forgetting-aware eval (${dataset.name}) ===`);
  console.log(`tenant: ${tenantId}\nisolation: ${isolation.mode}; not an atomic corpus snapshot\n`);
  console.log(`SQLite coordination: ${isolation.sourceSqliteCoordination}`);
  console.log(formatReport(report));
  console.log(
    JSON.stringify({
      denseFailureEvents: diagnostics.events,
      denseFailureEventsDropped: diagnostics.droppedEvents,
    }),
  );
  const stale = report.perQuery.filter((r) => (r.obsoleteRetrieved ?? []).length > 0);
  if (stale.length > 0) {
    console.log(`\n--- obsolete docs served (${stale.length} of ${report.queryCount} queries) ---`);
    for (const r of stale) {
      console.log(
        `  ${r.id} "${r.query}"  FAMA ${(r.famaAtK ?? 0).toFixed(2)}  recall ${r.recallAtK.toFixed(2)}`,
      );
      for (const id of r.obsoleteRetrieved ?? []) {
        console.log(`      rank ${r.retrieved.indexOf(id) + 1}: ${id}`);
      }
    }
  }
  const misses = report.perQuery.filter((r) => r.recallAtK === 0);
  if (misses.length > 0) {
    console.log(`\n--- current answer not in the top ${K} (${misses.length}) ---`);
    for (const r of misses) console.log(`  ${r.id} "${r.query}"`);
  }
  const open = gaps.filter((g) => (g.answeredBy ?? []).length === 0);
  const filled = gaps.filter((g) => (g.answeredBy ?? []).length > 0);
  if (filled.length > 0) {
    console.log(`\n--- documentation holes filled since labeling (${filled.length}) ---`);
    for (const g of filled) {
      const where = g.answerRank === null ? `NOT in the top ${K}` : `rank ${g.answerRank}`;
      console.log(`  ${g.id} "${g.query}" — answer at ${where}`);
    }
  }
  if (open.length > 0) {
    console.log(`\n--- documentation holes: no current doc answers these (${open.length}) ---`);
    for (const g of open) console.log(`  ${g.id} "${g.query}" — ${g.notes}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
