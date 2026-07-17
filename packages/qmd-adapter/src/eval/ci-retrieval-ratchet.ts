#!/usr/bin/env node
/**
 * CI retrieval RATCHET (bead compile-then-govern-6ps.6, Track 2 of the
 * "most-PROVEN" testing initiative).
 *
 * The problem this closes: `eval-retrieval-live.test.ts` and
 * `scripts/eval-retrieval.ts` both read the LIVE `~/.teamkb` index, so they
 * `describe.skipIf` / exit 2 on any cold runner. The real retrieval number
 * (governed-brain-v1) is therefore NEVER enforced in CI — it is a local-only
 * figure. This script makes retrieval a first-class, self-contained CI gate:
 *
 *   1. Build a THROWAWAY qmd BM25 index over the COMMITTED synthetic corpus
 *      (`fixtures/synthetic-corpus/`) in a temp dir — NEVER `~/.teamkb`.
 *   2. Run the `synthetic-v1` stratified query set through the exact same
 *      production `adapter.query()` BM25 path `brain_search` uses.
 *   3. Compute Recall@10 per stratum SEPARATELY (lexical + semantic), never the
 *      blended average — a healthy overall can hide a semantic collapse.
 *   4. Assert a RATCHET: fail (exit 1) if either stratum's Recall@10 drops below
 *      its committed baseline minus epsilon. This guards the retrieval we ship
 *      against regression; it deliberately does NOT gate on the absolute 0.85
 *      ADR-038 sufficiency bar (that is a build-the-semantic-path decision
 *      threshold, not a ship gate).
 *
 * Determinism: qmd BM25 over a fixed corpus + fixed queries is deterministic, so
 * the baseline in `datasets/synthetic-v1.ts` is a stable floor for the pinned
 * `@tobilu/qmd` version. Run via `pnpm --filter @qmd-team-intent-kb/qmd-adapter
 * eval:retrieval:ci` (puts the pinned workspace qmd on PATH); CI does `pnpm
 * build` first so this compiled entry can resolve its workspace-package imports.
 *
 * Exit codes: 0 = ratchet held; 1 = a stratum regressed (or an unexpected
 * error); 2 = qmd unavailable or the freshly built index answered nothing
 * (misconfig — fail loudly rather than report a fake 0).
 *
 * @module eval/ci-retrieval-ratchet
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QmdAdapter } from '../adapter.js';
import { reindex } from '../reindex/reindex.js';
import { runEval } from './run-eval.js';
import { stratify, formatStratifiedReport } from './stratified-report.js';
import type { StratumMetrics } from './stratified-report.js';
import { qmdRetrievalFn } from './qmd-retrieval.js';
import {
  SYNTHETIC_V1_DATASET,
  SYNTHETIC_V1_BASELINE,
  RATCHET_EPSILON,
} from './datasets/synthetic-v1.js';

/** A synthetic tenant — the temp index is bound to it; it never touches the real brain. */
const SYNTHETIC_TENANT = 'synthetic';

/**
 * Locate the committed synthetic corpus. This file runs compiled from
 * `dist/eval/ci-retrieval-ratchet.js` (CI) but the `.md` fixtures live in
 * `src/eval/fixtures/synthetic-corpus/` (tsc does not copy them), so resolve
 * against both the src layout (tsx) and the dist layout (compiled) and fail
 * loudly if neither exists — a missing corpus must not silently pass as "0 hits".
 */
function resolveCorpusDir(): string {
  const hereDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(hereDir, 'fixtures', 'synthetic-corpus'), // running from src (tsx)
    join(hereDir, '..', '..', 'src', 'eval', 'fixtures', 'synthetic-corpus'), // running from dist
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `synthetic corpus not found; looked in:\n  ${candidates.join('\n  ')}\n` +
      '(did the build move the fixtures, or is the working dir wrong?)',
  );
}

function qmdAvailable(): boolean {
  try {
    execFileSync('qmd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** One stratum's ratchet verdict. */
interface RatchetCheck {
  stratum: string;
  measured: number;
  baseline: number;
  floor: number;
  held: boolean;
}

function checkStratum(
  m: StratumMetrics | undefined,
  stratum: string,
  baseline: number,
): RatchetCheck {
  const measured = m?.meanRecallAtK ?? 0;
  const floor = baseline - RATCHET_EPSILON;
  return { stratum, measured, baseline, floor, held: measured >= floor };
}

/**
 * Build the temp index, run the eval, print the stratified report, and enforce
 * the ratchet. Returns the process exit code; a caller (or the entry guard)
 * turns that into `process.exit`.
 */
export async function runRetrievalRatchet(): Promise<number> {
  if (!qmdAvailable()) {
    console.error(
      'qmd binary not on PATH — cannot run the retrieval ratchet. Run via ' +
        '`pnpm --filter @qmd-team-intent-kb/qmd-adapter eval:retrieval:ci` so the pinned workspace qmd resolves.',
    );
    return 2;
  }

  const corpusDir = resolveCorpusDir();
  // Isolated temp base — TEAMKB_BASE_PATH drives every qmd index/registry path
  // (config/cache under <base>/qmd-index/<tenant>/...), so nothing here can read
  // or write the real `~/.teamkb`. MUST be set BEFORE constructing QmdAdapter,
  // whose executor snapshots the tenant XDG env at construction time.
  const tmpBase = mkdtempSync(join(tmpdir(), 'teamkb-retrieval-ratchet-'));
  process.env['TEAMKB_BASE_PATH'] = tmpBase;

  try {
    const exportDir = join(tmpBase, 'kb-export');
    cpSync(corpusDir, exportDir, { recursive: true });

    const adapter = new QmdAdapter({ tenantId: SYNTHETIC_TENANT, exportDir });
    const built = await reindex(adapter);
    if (!built.ok) {
      console.error(
        `Failed to build the synthetic qmd index: ${built.error.code}: ${built.error.message}`,
      );
      return 2;
    }

    const retrieve = qmdRetrievalFn(adapter, SYNTHETIC_TENANT, 'curated');
    const report = await runEval(SYNTHETIC_V1_DATASET, retrieve, { k: 10, backend: 'qmd-bm25' });

    // A totally empty result set means the index did not build, not that BM25
    // scored 0. Fail loudly (exit 2) rather than let the ratchet read a fake 0.
    if (!report.perQuery.some((r) => r.retrieved.length > 0)) {
      console.error(
        'Every query returned 0 hits against the freshly built synthetic index — ' +
          'the index is empty/misbuilt, not a real regression.',
      );
      return 2;
    }

    const sr = stratify(report, SYNTHETIC_V1_DATASET.queries);

    console.log(`\n=== Governed Second Brain — synthetic retrieval ratchet (${sr.dataset}) ===`);
    console.log(`corpus: ${corpusDir}`);
    console.log(
      `temp index: ${tmpBase}  ·  tenant: ${SYNTHETIC_TENANT}  ·  queries: ${report.queryCount}\n`,
    );
    console.log(formatStratifiedReport(sr));

    const lexical = sr.byKind.find((s) => s.stratum === 'lexical');
    const semantic = sr.byKind.find((s) => s.stratum === 'semantic');
    const tokenization = sr.byKind.find((s) => s.stratum === 'tokenization');
    const checks = [
      checkStratum(lexical, 'lexical', SYNTHETIC_V1_BASELINE.lexicalRecallAtK),
      checkStratum(semantic, 'semantic', SYNTHETIC_V1_BASELINE.semanticRecallAtK),
      checkStratum(tokenization, 'tokenization', SYNTHETIC_V1_BASELINE.tokenizationRecallAtK),
    ];

    console.log(`\n=== ratchet (per-stratum Recall@10 ≥ baseline − ${RATCHET_EPSILON}) ===`);
    for (const c of checks) {
      console.log(
        `  ${c.stratum.padEnd(9)} measured=${c.measured.toFixed(4)}  ` +
          `baseline=${c.baseline.toFixed(4)}  floor=${c.floor.toFixed(4)}  ` +
          `${c.held ? 'OK' : 'REGRESSED'}`,
      );
    }

    // Emit the machine-readable eval artifact (vps.3) — written on PASS and
    // FAIL alike so CI always uploads a tracked history of the numbers, not
    // just a green/red bit. Path overridable for local runs.
    writeEvalArtifact(sr, checks, report.perQuery);

    const regressed = checks.filter((c) => !c.held);
    if (regressed.length > 0) {
      console.error(
        `\nRATCHET FAILED — ${regressed.length} stratum/strata regressed below the committed floor:`,
      );
      for (const c of regressed) {
        console.error(
          `  ${c.stratum}: ${c.measured.toFixed(4)} < ${c.floor.toFixed(4)}. ` +
            'Investigate the retrieval change; if it is a legitimate improvement elsewhere, ' +
            're-measure and update SYNTHETIC_V1_BASELINE in the same PR.',
        );
      }
      // Surface which queries missed, for the person reading the failing log.
      const misses = report.perQuery.filter((r) => r.recallAtK === 0);
      if (misses.length > 0) {
        console.error(`\n  BM25 misses (${misses.length}/${report.queryCount}):`);
        for (const m of misses) {
          console.error(`    [${m.kind ?? 'untagged'}] ${m.id}: "${m.query}"`);
        }
      }
      return 1;
    }

    console.log('\nRATCHET PASS — no stratum regressed below its committed floor.');
    return 0;
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

/**
 * Write the JSON eval artifact (vps.3): the stratified metrics, the ratchet
 * verdicts, and the per-query outcomes. CI uploads this as a build artifact so
 * eval history is a tracked series of numbers rather than console scrollback.
 * Default path is `eval-results/synthetic-v1.json` under the package dir;
 * override with RETRIEVAL_EVAL_JSON_PATH.
 */
function writeEvalArtifact(
  sr: ReturnType<typeof stratify>,
  checks: RatchetCheck[],
  perQuery: ReadonlyArray<{
    id: string;
    kind?: string;
    query: string;
    recallAtK: number;
    retrieved: readonly string[];
  }>,
): void {
  const hereDir = dirname(fileURLToPath(import.meta.url));
  const defaultPath = join(hereDir, '..', '..', 'eval-results', 'synthetic-v1.json');
  const outPath = process.env['RETRIEVAL_EVAL_JSON_PATH'] ?? defaultPath;
  const artifact = {
    dataset: sr.dataset,
    backend: sr.backend,
    k: sr.k,
    generatedAt: new Date().toISOString(),
    overall: sr.overall,
    byKind: sr.byKind,
    ratchet: { epsilon: RATCHET_EPSILON, checks, pass: checks.every((c) => c.held) },
    perQuery: perQuery.map((q) => ({
      id: q.id,
      kind: q.kind ?? 'untagged',
      query: q.query,
      hit: q.recallAtK > 0,
      recallAtK: q.recallAtK,
      retrievedTop3: q.retrieved.slice(0, 3),
    })),
  };
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`\neval artifact written: ${outPath}`);
  } catch (err: unknown) {
    // The artifact is evidence, not the gate — never let a write failure flip
    // the ratchet verdict.
    console.error(`WARN could not write eval artifact to ${outPath}:`, err);
  }
}

/** Entry point — resolve the exit code and terminate. */
export async function main(): Promise<void> {
  let code: number;
  try {
    code = await runRetrievalRatchet();
  } catch (err: unknown) {
    console.error('retrieval ratchet crashed:', err);
    code = 1;
  }
  process.exit(code);
}

// Direct-execution guard: run `main()` only when invoked as the process entry
// (`node dist/eval/ci-retrieval-ratchet.js`), not when imported. Mirrors cli.ts.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
