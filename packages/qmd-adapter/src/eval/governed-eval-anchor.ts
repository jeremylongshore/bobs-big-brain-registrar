#!/usr/bin/env node
/**
 * Governed retrieval eval ANCHOR (GSB blueprint Track C1).
 *
 * The synthetic PR-time ratchet (`ci-retrieval-ratchet.ts`) guards retrieval in
 * CI, but only over a committed toy corpus. The REAL number — the hand-labeled
 * `governed-brain-v1` query set whose gold ids are `qmd://` citations into the
 * real `~/.teamkb/kb-export` — has never been enforced anywhere, because that
 * corpus is private (~80 MB, never committed) and lives only on the dev box.
 *
 * This script makes the real number a scheduled, deterministic anchor:
 *
 *   1. Resolve a FROZEN corpus snapshot: a tar.zst of `kb-export` pinned by a
 *      committed lock file (`eval-results/governed-brain-v1-snapshot.lock.json`)
 *      carrying its SHA-256. The tarball itself stays under
 *      `~/.teamkb/eval-anchor/` on the box — only the hash is committed.
 *      Hash mismatch = exit 2: never eval an unpinned corpus.
 *   2. Extract to a temp dir, build a THROWAWAY index there (TEAMKB_BASE_PATH
 *      isolation — the live `~/.teamkb` is never read or written), and run all
 *      governed-brain-v1 queries through the production `adapter.query()` path.
 *   3. Compare per-stratum Recall@10 against the committed floor file
 *      (`eval-results/governed-brain-v1-floor.json`), with the same epsilon
 *      slack as the synthetic ratchet. Regression = exit 1.
 *   4. No floor file yet = exit 3 with a proposed floor printed + written —
 *      never an invented passing verdict.
 *   5. Optionally (GOVERNED_EVAL_LIVE=1) also run the same queries against a
 *      temp index built from the LIVE kb-export — informational only, clearly
 *      labeled "live (unfrozen)", never part of the verdict.
 *
 * Determinism: frozen corpus + fixed queries + pinned workspace qmd = a stable
 * floor. The live corpus drifts daily (that is its job), which is exactly why
 * the anchor evals the frozen snapshot by default.
 *
 * This is NOT a CI gate — it runs on the dev box via the
 * `bbb-eval-governed.timer` systemd user timer (the corpus can never reach a
 * GitHub runner). The synthetic ratchet remains the PR-time gate.
 *
 * Run: `pnpm --filter @qmd-team-intent-kb/qmd-adapter eval:governed:local`
 * (puts the pinned workspace qmd on PATH; `pnpm -r build` first).
 *
 * Exit codes: 0 = floor held; 1 = a stratum regressed (or unexpected error);
 * 2 = qmd/snapshot unavailable or hash mismatch or empty index (fail loud);
 * 3 = no committed floor yet (proposed floor emitted).
 *
 * @module eval/governed-eval-anchor
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QmdAdapter } from '../adapter.js';
import type { QmdAdapterConfig } from '../config.js';
import { reindex } from '../reindex/reindex.js';
import { runEval } from './run-eval.js';
import { stratify, formatStratifiedReport } from './stratified-report.js';
import type { StratifiedReport } from './stratified-report.js';
import { qmdRetrievalFn } from './qmd-retrieval.js';
import { GOVERNED_BRAIN_V1_DATASET } from './datasets/governed-brain-v1.js';
// Deliberate coupling: the synthetic ratchet's epsilon is the project's one
// canonical regression-slack value; the anchor reuses it so the two gates can
// never drift apart silently.
import { RATCHET_EPSILON } from './datasets/synthetic-v1.js';

/** The throwaway tenant the temp anchor index is bound to. Never the real brain's tenant. */
const ANCHOR_TENANT = 'governed-eval-anchor';

/**
 * qmd executor timeout for the anchor. The DEFAULT_TIMEOUT (30 s) is tuned for
 * interactive search; a cold `qmd collection add` over the real corpus (~17k
 * files — guides alone is ~10k) takes minutes. Measured 2026-07-19: kb-guides
 * registration alone was ~65 s on the dev box.
 */
const ANCHOR_QMD_TIMEOUT_MS = 600_000;

/** The committed lock file pinning the frozen snapshot (relative to the package root). */
export const SNAPSHOT_LOCK_BASENAME = 'governed-brain-v1-snapshot.lock.json';

/** The committed per-stratum floor file (relative to the package root). */
export const FLOOR_BASENAME = 'governed-brain-v1-floor.json';

/** Shape of `eval-results/governed-brain-v1-snapshot.lock.json`. */
export interface SnapshotLock {
  /** Lock-format version — bump on any breaking shape change. */
  schemaVersion: number;
  /**
   * Default path of the frozen tarball on the eval box (override:
   * GOVERNED_EVAL_SNAPSHOT). A leading `~/` resolves against the runtime
   * home directory so the committed lock carries no box-specific username —
   * the binding content of the lock is the SHA-256, not the path.
   */
  tarballPath: string;
  /** SHA-256 (hex) of the tarball — the pin. Mismatch = refuse to eval. */
  sha256: string;
  createdAtUtc: string;
  /** Files inside the snapshot's kb-export tree at freeze time. */
  fileCount: number;
  corpusNote: string;
}

/** Shape of `eval-results/governed-brain-v1-floor.json`. */
export interface GovernedFloor {
  /** Floor-format version — bump on any breaking shape change. */
  schemaVersion: number;
  dataset: string;
  k: number;
  /** Slack below each floor value before a measurement counts as a regression. */
  epsilon: number;
  /** Per-stratum mean Recall@10 floors (e.g. lexical / semantic / overall). */
  floors: Record<string, number>;
  measuredAtUtc: string;
  /** SHA-256 of the snapshot the floors were measured against. */
  snapshotSha256: string;
  note: string;
}

/**
 * Expand a leading `~/` against the runtime home directory. The committed lock
 * stores the tarball path in `~/`-form so no box-specific username lands in
 * the repo; the SHA-256 pin — not the path — is what binds the snapshot.
 */
export function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** One stratum's floor verdict. */
export interface FloorCheck {
  stratum: string;
  measured: number;
  baseline: number;
  floor: number;
  held: boolean;
}

/** Streaming-free SHA-256 of a file (hex). The snapshot is ~80 MB — fine in one read. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Verify a tarball against its committed lock. Pure verdict — no side effects. */
export function verifySnapshotAgainstLock(
  lock: SnapshotLock,
  tarballPath: string,
): { ok: true; sha256: string } | { ok: false; reason: string } {
  if (!existsSync(tarballPath)) {
    return { ok: false, reason: `snapshot tarball not found: ${tarballPath}` };
  }
  const actual = sha256File(tarballPath);
  if (actual !== lock.sha256) {
    return {
      ok: false,
      reason:
        `snapshot SHA-256 mismatch for ${tarballPath}:\n` +
        `  locked:   ${lock.sha256}\n` +
        `  actual:   ${actual}\n` +
        'Refusing to eval an unpinned corpus. If the snapshot was intentionally ' +
        'refrozen, update the lock file AND re-measure the floor in the same change.',
    };
  }
  return { ok: true, sha256: actual };
}

/**
 * Compare a stratified report against the committed per-stratum floors.
 * A stratum listed in the floors but absent from the report measures 0 —
 * a vanished stratum is a regression, not a pass.
 */
export function checkFloors(
  sr: StratifiedReport,
  floors: Record<string, number>,
  epsilon: number,
): FloorCheck[] {
  return Object.entries(floors)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stratum, baseline]) => {
      const metrics =
        stratum === 'overall' ? sr.overall : sr.byKind.find((s) => s.stratum === stratum);
      const measured = metrics?.meanRecallAtK ?? 0;
      const floor = baseline - epsilon;
      return { stratum, measured, baseline, floor, held: measured >= floor };
    });
}

/** Build a proposed floor file from measured numbers (first run / refreeze). */
export function proposeFloor(sr: StratifiedReport, snapshotSha256: string): GovernedFloor {
  const floors: Record<string, number> = { overall: round4(sr.overall.meanRecallAtK) };
  for (const s of sr.byKind) {
    floors[s.stratum] = round4(s.meanRecallAtK);
  }
  return {
    schemaVersion: 1,
    dataset: sr.dataset,
    k: sr.k,
    epsilon: RATCHET_EPSILON,
    floors,
    measuredAtUtc: new Date().toISOString(),
    snapshotSha256,
    note:
      'Per-stratum mean Recall@10 floors measured against the frozen governed-brain-v1 ' +
      'snapshot. Update ONLY alongside a deliberate re-measure (and lock update on refreeze).',
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Package root (works from src via tsx AND from dist compiled). */
function packageRootDir(): string {
  const hereDir = dirname(fileURLToPath(import.meta.url));
  return join(hereDir, '..', '..');
}

function qmdAvailable(): boolean {
  try {
    execFileSync('qmd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the frozen tarball and build a throwaway index over it.
 * Returns the ready adapter's export dir inside `tmpBase`.
 * TEAMKB_BASE_PATH MUST already point at `tmpBase` before calling — the
 * adapter's executor snapshots the tenant env at construction time.
 */
function extractSnapshot(tarballPath: string, tmpBase: string): string {
  execFileSync('tar', ['-x', '--zstd', '-f', tarballPath, '-C', tmpBase], { stdio: 'inherit' });
  const exportDir = join(tmpBase, 'kb-export');
  if (!existsSync(exportDir)) {
    throw new Error(
      `snapshot extracted but ${exportDir} is missing — the tarball must contain kb-export/ at its root`,
    );
  }
  return exportDir;
}

/** Wall-clock + outcome of a dense index build inside an eval arm (B4). */
interface DenseBuildInfo {
  wallClockMs: number;
  embedded: number;
  skipped: number;
  removed: number;
  totalDocs: number;
}

/** Build a temp index over `exportDir` and run the full governed-brain-v1 set. */
async function evalCorpus(
  exportDir: string,
  backendLabel: string,
  opts: {
    /** Opt-in rerank arm for the A/B comparison (044-AT-DECR ship order). */
    rerank?: QmdAdapterConfig['rerank'];
    /** Opt-in dense arm for the A/B comparison (B4 ship gate). */
    dense?: QmdAdapterConfig['dense'];
    /** Reuse the index a prior evalCorpus call already built for this tenant. */
    skipIndexBuild?: boolean;
    /**
     * Build the dense sidecar index (embed the corpus) before querying, and
     * report its wall-clock. Requires `dense`. Fails the arm loudly when the
     * embedder is down or the build embeds nothing — an A/B arm must never
     * report numbers from a silently-empty dense index.
     */
    buildDenseIndex?: boolean;
    /**
     * Log a per-query progress line (index i/N + wall-clock ms + top hit) during
     * the verdict phase. Turns a slow/hung query phase from a silent black box
     * into an observable stream — added after a full run's query phase was
     * misread as hung when it was actually still building.
     */
    logProgress?: boolean;
  } = {},
): Promise<
  | { ok: true; sr: StratifiedReport; perQuery: EvalPerQuery[]; denseBuild?: DenseBuildInfo }
  | { ok: false; reason: string }
> {
  const adapter = new QmdAdapter({
    tenantId: ANCHOR_TENANT,
    exportDir,
    timeout: ANCHOR_QMD_TIMEOUT_MS,
    ...(opts.rerank ? { rerank: opts.rerank } : {}),
    ...(opts.dense ? { dense: opts.dense } : {}),
  });
  if (!opts.skipIndexBuild) {
    const built = await reindex(adapter);
    if (!built.ok) {
      return {
        ok: false,
        reason: `index build failed: ${built.error.code}: ${built.error.message}`,
      };
    }
  }
  let denseBuild: DenseBuildInfo | undefined;
  if (opts.buildDenseIndex === true) {
    const t0 = Date.now();
    const report = await adapter.denseSync();
    const wallClockMs = Date.now() - t0;
    if (report === null) {
      return { ok: false, reason: 'dense build requested but the adapter has no dense arm' };
    }
    if (report.serviceDown) {
      return {
        ok: false,
        reason: `dense index build aborted — embedding service down (embedded ${report.embedded}, skipped ${report.skipped})`,
      };
    }
    if (report.embedded === 0 && report.totalDocs > 0) {
      return {
        ok: false,
        reason: `dense index build embedded 0 of ${report.totalDocs} docs — refusing to eval an empty dense index`,
      };
    }
    denseBuild = {
      wallClockMs,
      embedded: report.embedded,
      skipped: report.skipped,
      removed: report.removed,
      totalDocs: report.totalDocs,
    };
    console.log(
      `dense index built: ${report.embedded}/${report.totalDocs} docs embedded ` +
        `(${report.skipped} skipped) in ${(wallClockMs / 60_000).toFixed(1)} min`,
    );
  }
  const baseRetrieve = qmdRetrievalFn(adapter, ANCHOR_TENANT, 'curated');
  const totalQueries = GOVERNED_BRAIN_V1_DATASET.queries.length;
  let queryNum = 0;
  const retrieve = opts.logProgress
    ? async (q: string, k: number): Promise<string[]> => {
        const t0 = Date.now();
        const ids = await baseRetrieve(q, k);
        queryNum++;
        console.log(
          `  [verdict] query ${queryNum}/${totalQueries}  ${Date.now() - t0} ms  ` +
            `top=${ids[0] ?? '(none)'}`,
        );
        return ids;
      }
    : baseRetrieve;
  const report = await runEval(GOVERNED_BRAIN_V1_DATASET, retrieve, {
    k: 10,
    backend: backendLabel,
  });
  if (!report.perQuery.some((r) => r.retrieved.length > 0)) {
    return {
      ok: false,
      reason:
        'every query returned 0 hits against the freshly built index — the index is ' +
        'empty/misbuilt, not a real score',
    };
  }
  return {
    ok: true,
    ...(denseBuild ? { denseBuild } : {}),
    sr: stratify(report, GOVERNED_BRAIN_V1_DATASET.queries),
    perQuery: report.perQuery.map((q) => ({
      id: q.id,
      kind: q.kind ?? 'untagged',
      query: q.query,
      hit: q.recallAtK > 0,
      recallAtK: q.recallAtK,
      retrievedTop3: q.retrieved.slice(0, 3),
    })),
  };
}

interface EvalPerQuery {
  id: string;
  kind: string;
  query: string;
  hit: boolean;
  recallAtK: number;
  retrievedTop3: string[];
}

/**
 * The full anchor run. Returns the process exit code (0 held / 1 regressed /
 * 2 unavailable-or-unpinned / 3 no floor yet).
 */
export async function runGovernedEvalAnchor(): Promise<number> {
  if (!qmdAvailable()) {
    console.error(
      'qmd binary not on PATH — run via ' +
        '`pnpm --filter @qmd-team-intent-kb/qmd-adapter eval:governed:local` so the ' +
        'pinned workspace qmd resolves.',
    );
    return 2;
  }

  const resultsDir = join(packageRootDir(), 'eval-results');
  const lockPath = join(resultsDir, SNAPSHOT_LOCK_BASENAME);
  if (!existsSync(lockPath)) {
    console.error(
      `snapshot lock file not found: ${lockPath}\n` +
        'The anchor never evals an unpinned corpus. Freeze a snapshot ' +
        '(tar -C ~/.teamkb -cf - kb-export | zstd) and commit its lock first.',
    );
    return 2;
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as SnapshotLock;
  const tarballPath = expandHome(process.env['GOVERNED_EVAL_SNAPSHOT'] ?? lock.tarballPath);

  const verified = verifySnapshotAgainstLock(lock, tarballPath);
  if (!verified.ok) {
    console.error(verified.reason);
    return 2;
  }

  // Isolated temp base — TEAMKB_BASE_PATH drives every qmd index/registry path,
  // so nothing here can read or write the real `~/.teamkb`. MUST be set BEFORE
  // constructing QmdAdapter (its executor snapshots env at construction).
  const tmpBase = mkdtempSync(join(tmpdir(), 'teamkb-governed-anchor-'));
  process.env['TEAMKB_BASE_PATH'] = tmpBase;

  try {
    const exportDir = extractSnapshot(tarballPath, tmpBase);
    const frozen = await evalCorpus(exportDir, 'qmd-bm25+fts5-rrf (frozen snapshot)');
    if (!frozen.ok) {
      console.error(frozen.reason);
      return 2;
    }

    console.log(
      `\n=== Governed Second Brain — REAL-corpus retrieval anchor (${frozen.sr.dataset}) ===`,
    );
    console.log(`snapshot: ${tarballPath}`);
    console.log(`sha256:   ${verified.sha256}  ·  frozen ${lock.createdAtUtc}`);
    console.log(`temp index: ${tmpBase}  ·  tenant: ${ANCHOR_TENANT}\n`);
    console.log(formatStratifiedReport(frozen.sr));

    const floorPath = join(resultsDir, FLOOR_BASENAME);
    if (!existsSync(floorPath)) {
      const proposed = proposeFloor(frozen.sr, verified.sha256);
      const proposedPath = join(resultsDir, 'governed-brain-v1-floor.proposed.json');
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(proposedPath, `${JSON.stringify(proposed, null, 2)}\n`);
      console.log(
        `\nNO FLOOR YET — ${floorPath} does not exist. Measured numbers above are ` +
          'REPORTED, not judged (a first run must never invent a passing verdict).',
      );
      console.log(`proposed floor written: ${proposedPath}`);
      console.log('proposed floor JSON:');
      console.log(JSON.stringify(proposed, null, 2));
      writeArtifact(resultsDir, frozen.sr, verified.sha256, lock, null, [], frozen.perQuery);
      return 3;
    }

    const floor = JSON.parse(readFileSync(floorPath, 'utf8')) as GovernedFloor;
    const checks = checkFloors(frozen.sr, floor.floors, floor.epsilon);

    console.log(`\n=== floor (per-stratum Recall@10 ≥ floor − ${floor.epsilon}) ===`);
    for (const c of checks) {
      console.log(
        `  ${c.stratum.padEnd(12)} measured=${c.measured.toFixed(4)}  ` +
          `floor=${c.baseline.toFixed(4)}  min=${c.floor.toFixed(4)}  ` +
          `${c.held ? 'OK' : 'REGRESSED'}`,
      );
    }
    if (floor.snapshotSha256 !== verified.sha256) {
      console.warn(
        'WARN: the floor was measured against a DIFFERENT snapshot ' +
          `(floor: ${floor.snapshotSha256.slice(0, 12)}…, current: ${verified.sha256.slice(0, 12)}…). ` +
          'Re-measure the floor after refreezing.',
      );
    }

    // Informational rerank A/B arm (044-AT-DECR ship order: the reranker is
    // judged on this harness BEFORE any default wiring). Same snapshot, same
    // already-built index, second adapter with the opt-in rerank stage. NEVER
    // part of the verdict — the floors gate the fused arm only.
    await maybeRunRerankArm(exportDir, frozen.sr, resultsDir, verified.sha256);

    // Informational dense A/B arm (B4 ship gate: dense retrieval is judged on
    // this harness BEFORE any default wiring — same discipline as rerank).
    await maybeRunDenseArm(exportDir, frozen.sr, resultsDir, verified.sha256);

    // Informational live run — never part of the verdict, off by default so the
    // frozen anchor stays the deterministic path.
    await maybeRunLiveInformational();

    writeArtifact(resultsDir, frozen.sr, verified.sha256, lock, floor, checks, frozen.perQuery);

    const regressed = checks.filter((c) => !c.held);
    if (regressed.length > 0) {
      console.error(
        `\nANCHOR FAILED — ${regressed.length} stratum/strata regressed below the committed floor:`,
      );
      for (const c of regressed) {
        console.error(
          `  ${c.stratum}: ${c.measured.toFixed(4)} < ${c.floor.toFixed(4)}. ` +
            'Investigate the retrieval change; if it is a legitimate improvement elsewhere, ' +
            're-measure and update the floor file in the same PR.',
        );
      }
      return 1;
    }

    console.log('\nANCHOR PASS — no stratum regressed below its committed floor.');
    return 0;
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

/**
 * GOVERNED_EVAL_RERANK=1: the A/B arm for the reranker verdict (KR1.3). Runs
 * the identical frozen query set through the SAME temp index with the opt-in
 * cross-encoder rerank stage enabled (candidateWindow 50 → topN 10, so both
 * arms are compared at the eval's k=10). Reranker URL override:
 * GOVERNED_EVAL_RERANK_URL (default the bbb-reranker loopback service).
 * Informational only — prints the side-by-side per-stratum deltas and writes
 * `governed-brain-v1-rerank.json`; the exit code never depends on this arm.
 */
async function maybeRunRerankArm(
  exportDir: string,
  fusedSr: StratifiedReport,
  resultsDir: string,
  snapshotSha256: string,
): Promise<void> {
  if (process.env['GOVERNED_EVAL_RERANK'] !== '1') return;
  const url = process.env['GOVERNED_EVAL_RERANK_URL'] ?? 'http://127.0.0.1:8097';
  // CPU-latency reality (measured 2026-07-19 on the 8-core dev box): the
  // Qwen3-0.6B cross-encoder scores ~2.5 s/doc at 600 chars, so a 50-doc
  // window runs ~2 min per query. The A/B arm is an OFFLINE measurement and
  // takes the hit (300 s timeout); docs are truncated to 600 chars to keep
  // the full-window run under ~2 h for the 42-query set.
  const reranked = await evalCorpus(exportDir, 'qmd-bm25+fts5-rrf+qwen3-rerank (frozen snapshot)', {
    skipIndexBuild: true,
    rerank: {
      enabled: true,
      url,
      candidateWindow: 50,
      topN: 10,
      maxDocChars: 600,
      timeoutMs: 300_000,
    },
  });
  if (!reranked.ok) {
    console.error(`\nrerank arm FAILED (informational, verdict unaffected): ${reranked.reason}`);
    return;
  }
  console.log('\n=== rerank A/B arm (informational — 044-AT-DECR ship-gate evidence) ===');
  console.log(formatStratifiedReport(reranked.sr));
  console.log('\n=== per-stratum delta (reranked − fused) ===');
  const fusedBy = new Map(fusedSr.byKind.map((s) => [s.stratum, s]));
  const rows = [
    ...reranked.sr.byKind.map((s) => ({ s, f: fusedBy.get(s.stratum) })),
    { s: reranked.sr.overall, f: fusedSr.overall },
  ];
  for (const { s, f } of rows) {
    if (!f) continue;
    const d = (a: number, b: number): string => {
      const delta = a - b;
      return `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`;
    };
    console.log(
      `  ${s.stratum.padEnd(9)} ΔRecall@10=${d(s.meanRecallAtK, f.meanRecallAtK)}  ` +
        `ΔnDCG@10=${d(s.meanNdcgAtK, f.meanNdcgAtK)}  ΔMRR=${d(s.mrr, f.mrr)}`,
    );
  }
  try {
    const outPath = join(resultsDir, 'governed-brain-v1-rerank.json');
    writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          dataset: reranked.sr.dataset,
          snapshotSha256,
          rerankerUrl: url,
          fused: { overall: fusedSr.overall, byKind: fusedSr.byKind },
          reranked: { overall: reranked.sr.overall, byKind: reranked.sr.byKind },
          perQuery: reranked.perQuery,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`rerank A/B artifact written: ${outPath}`);
  } catch (err: unknown) {
    console.error('WARN could not write the rerank A/B artifact:', err);
  }
}

/**
 * GOVERNED_EVAL_DENSE=1: the A/B arm for the dense-retrieval verdict (B4).
 * Builds the sqlite-vec sidecar index over the SAME extracted frozen corpus
 * (embedding every doc via the local `bbb-embedder` service — an offline,
 * measured cost reported as wall-clock), then runs the identical frozen query
 * set through the same lexical indexes with the dense list joining the RRF
 * fusion. Embedder URL override: GOVERNED_EVAL_DENSE_URL (default the
 * bbb-embedder loopback service). Informational only — prints the
 * side-by-side per-stratum deltas, the ship-gate readout, and writes
 * `governed-brain-v1-dense.json`; the exit code never depends on this arm.
 *
 * SHIP GATE (blueprint B4, judged from this run's own fused baseline):
 * semantic Recall@10 must beat the fused arm's semantic Recall@10 materially
 * — this build exists because dense should retrieve what lexical cannot —
 * and lexical Recall@10 must not drop below its fused baseline minus the
 * canonical epsilon.
 */
async function maybeRunDenseArm(
  exportDir: string,
  fusedSr: StratifiedReport,
  resultsDir: string,
  snapshotSha256: string,
): Promise<void> {
  if (process.env['GOVERNED_EVAL_DENSE'] !== '1') return;
  // Hard fail-open boundary: this is an INFORMATIONAL arm and must never be
  // able to fail the anchor verdict. `evalCorpus` returns {ok:false} for the
  // expected failure modes, but an unexpected throw anywhere below (embedder
  // OOM-killed mid-build, a runEval defect, a disk error) would otherwise
  // propagate to main() and print "governed eval anchor crashed" INSTEAD of
  // "ANCHOR PASS" on the perfectly-good fused floor. Same discipline the
  // reranker arm follows — the model side can never take the deterministic
  // verdict down.
  try {
    await runDenseArm(exportDir, fusedSr, resultsDir, snapshotSha256);
  } catch (err: unknown) {
    console.error(
      '\ndense arm CRASHED (informational, verdict unaffected — the fused ' +
        'floor still governs):',
      err,
    );
  }
}

async function runDenseArm(
  exportDir: string,
  fusedSr: StratifiedReport,
  resultsDir: string,
  snapshotSha256: string,
): Promise<void> {
  const url = process.env['GOVERNED_EVAL_DENSE_URL'] ?? 'http://127.0.0.1:8098';

  // Embedding the full 17k-doc corpus takes ~3 h; GOVERNED_EVAL_DENSE_PREBUILT
  // lets a run REUSE an already-built dense-vec.sqlite (copied into the temp
  // tenant dir so the eval never mutates the preserved artifact) and run ONLY
  // the fast verdict phase. The index carries its own model+dims+prefix pin, so
  // opening it fail-closed verifies it matches this code (a mismatch would wipe
  // it, which we detect below via the empty-index guard). This makes every
  // re-measure minutes, not hours.
  const prebuilt = process.env['GOVERNED_EVAL_DENSE_PREBUILT'];
  let denseIndexPath: string | undefined;
  const buildDenseIndex = prebuilt === undefined;
  if (prebuilt !== undefined) {
    const resolved = expandHome(prebuilt);
    if (!existsSync(resolved)) {
      console.error(`\ndense arm FAILED: GOVERNED_EVAL_DENSE_PREBUILT not found: ${resolved}`);
      return;
    }
    denseIndexPath = join(
      process.env['TEAMKB_BASE_PATH'] ?? tmpdir(),
      'dense-prebuilt-reuse.sqlite',
    );
    cpSync(resolved, denseIndexPath);
    console.log(
      `\ndense arm: REUSING prebuilt index ${resolved} (${denseIndexPath}) — ` +
        'skipping the corpus embed, running the verdict phase only.',
    );
  }

  const dense = await evalCorpus(
    exportDir,
    'qmd-bm25+fts5+embeddinggemma-dense-rrf (frozen snapshot)',
    {
      skipIndexBuild: true, // the lexical indexes are already built for this tenant
      buildDenseIndex, // build the dense sidecar unless reusing a prebuilt one
      logProgress: true, // per-query verdict-phase progress (never a silent black box again)
      dense: {
        enabled: true,
        url,
        searchK: 50,
        maxDocChars: 2000, // matches DEFAULT_DENSE_MAX_DOC_CHARS — the shipped default
        timeoutMs: 30_000, // offline arm: a slow query-embed is data, not an outage
        ...(denseIndexPath ? { indexPath: denseIndexPath } : {}),
      },
    },
  );
  if (!dense.ok) {
    console.error(`\ndense arm FAILED (informational, verdict unaffected): ${dense.reason}`);
    return;
  }
  console.log('\n=== dense A/B arm (informational — B4 ship-gate evidence) ===');
  console.log(formatStratifiedReport(dense.sr));
  console.log('\n=== per-stratum delta (dense-fused − lexical-fused) ===');
  const fusedBy = new Map(fusedSr.byKind.map((s) => [s.stratum, s]));
  const rows = [
    ...dense.sr.byKind.map((s) => ({ s, f: fusedBy.get(s.stratum) })),
    { s: dense.sr.overall, f: fusedSr.overall },
  ];
  const d = (a: number, b: number): string => {
    const delta = a - b;
    return `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`;
  };
  for (const { s, f } of rows) {
    if (!f) continue;
    console.log(
      `  ${s.stratum.padEnd(9)} ΔRecall@10=${d(s.meanRecallAtK, f.meanRecallAtK)}  ` +
        `ΔnDCG@10=${d(s.meanNdcgAtK, f.meanNdcgAtK)}  ΔMRR=${d(s.mrr, f.mrr)}`,
    );
  }

  // Ship-gate readout (informational): semantic must improve materially,
  // lexical must hold within the canonical epsilon of its fused baseline.
  const fusedSemantic = fusedSr.byKind.find((s) => s.stratum === 'semantic');
  const fusedLexical = fusedSr.byKind.find((s) => s.stratum === 'lexical');
  const denseSemantic = dense.sr.byKind.find((s) => s.stratum === 'semantic');
  const denseLexical = dense.sr.byKind.find((s) => s.stratum === 'lexical');
  let gate: {
    semanticBaseline: number;
    semanticMeasured: number;
    semanticImproved: boolean;
    lexicalBaseline: number;
    lexicalMeasured: number;
    lexicalHeld: boolean;
    epsilon: number;
    verdict: 'PASS' | 'MISS';
  } | null = null;
  if (fusedSemantic && fusedLexical && denseSemantic && denseLexical) {
    const semanticImproved =
      denseSemantic.meanRecallAtK > fusedSemantic.meanRecallAtK + RATCHET_EPSILON;
    const lexicalHeld = denseLexical.meanRecallAtK >= fusedLexical.meanRecallAtK - RATCHET_EPSILON;
    gate = {
      semanticBaseline: fusedSemantic.meanRecallAtK,
      semanticMeasured: denseSemantic.meanRecallAtK,
      semanticImproved,
      lexicalBaseline: fusedLexical.meanRecallAtK,
      lexicalMeasured: denseLexical.meanRecallAtK,
      lexicalHeld,
      epsilon: RATCHET_EPSILON,
      verdict: semanticImproved && lexicalHeld ? 'PASS' : 'MISS',
    };
    console.log(
      `\nship gate: semantic Recall@10 ${gate.semanticMeasured.toFixed(4)} vs baseline ` +
        `${gate.semanticBaseline.toFixed(4)} (${semanticImproved ? 'improved' : 'NOT materially improved'}); ` +
        `lexical ${gate.lexicalMeasured.toFixed(4)} vs floor ` +
        `${(gate.lexicalBaseline - gate.epsilon).toFixed(4)} (${lexicalHeld ? 'held' : 'REGRESSED'}) ` +
        `→ ${gate.verdict}`,
    );
  }
  try {
    const outPath = join(resultsDir, 'governed-brain-v1-dense.json');
    writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          dataset: dense.sr.dataset,
          snapshotSha256,
          embedderUrl: url,
          denseIndexBuild: dense.denseBuild ?? null,
          // Provenance: whether the dense index was freshly built or reused from
          // a preserved prebuilt (null = freshly built this run).
          reusedPrebuiltIndex: prebuilt ?? null,
          gate,
          fused: { overall: fusedSr.overall, byKind: fusedSr.byKind },
          dense: { overall: dense.sr.overall, byKind: dense.sr.byKind },
          perQuery: dense.perQuery,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`dense A/B artifact written: ${outPath}`);
  } catch (err: unknown) {
    console.error('WARN could not write the dense A/B artifact:', err);
  }
}

/**
 * GOVERNED_EVAL_LIVE=1: run the same query set against a temp index built from
 * a COPY of the live kb-export. Numbers drift with the corpus — labeled as such
 * and never gated. Any failure here is reported and swallowed.
 */
async function maybeRunLiveInformational(): Promise<void> {
  if (process.env['GOVERNED_EVAL_LIVE'] !== '1') return;
  const liveExport = join(homedir(), '.teamkb', 'kb-export');
  if (!existsSync(liveExport)) {
    console.log('\n(live run requested but ~/.teamkb/kb-export does not exist — skipped)');
    return;
  }
  const liveTmp = mkdtempSync(join(tmpdir(), 'teamkb-governed-live-'));
  process.env['TEAMKB_BASE_PATH'] = liveTmp;
  try {
    const exportCopy = join(liveTmp, 'kb-export');
    cpSync(liveExport, exportCopy, { recursive: true });
    const live = await evalCorpus(exportCopy, 'qmd-bm25+fts5-rrf (live, unfrozen)');
    if (!live.ok) {
      console.warn(`\nlive (unfrozen, informational) run failed: ${live.reason}`);
      return;
    }
    console.log('\n=== live (unfrozen, informational — NOT the anchor verdict) ===');
    console.log(formatStratifiedReport(live.sr));
  } catch (err: unknown) {
    console.warn('\nlive (unfrozen, informational) run crashed:', err);
  } finally {
    rmSync(liveTmp, { recursive: true, force: true });
  }
}

/**
 * JSON artifact mirroring the synthetic ratchet's `writeEvalArtifact`: metrics,
 * snapshot pin, floors + verdicts, per-query outcomes. Evidence, not the gate —
 * a write failure never flips the verdict. Path override: GOVERNED_EVAL_JSON_PATH.
 */
function writeArtifact(
  resultsDir: string,
  sr: StratifiedReport,
  snapshotSha256: string,
  lock: SnapshotLock,
  floor: GovernedFloor | null,
  checks: FloorCheck[],
  perQuery: EvalPerQuery[],
): void {
  const outPath =
    process.env['GOVERNED_EVAL_JSON_PATH'] ?? join(resultsDir, 'governed-brain-v1.json');
  const artifact = {
    dataset: sr.dataset,
    backend: sr.backend,
    k: sr.k,
    generatedAt: new Date().toISOString(),
    snapshot: {
      tarballPath: lock.tarballPath,
      sha256: snapshotSha256,
      createdAtUtc: lock.createdAtUtc,
      fileCount: lock.fileCount,
    },
    overall: sr.overall,
    byKind: sr.byKind,
    floor: floor
      ? { epsilon: floor.epsilon, floors: floor.floors, checks, pass: checks.every((c) => c.held) }
      : null,
    perQuery,
  };
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`\neval artifact written: ${outPath}`);
  } catch (err: unknown) {
    console.error(`WARN could not write eval artifact to ${outPath}:`, err);
  }
}

/** Entry point — resolve the exit code and terminate. */
export async function main(): Promise<void> {
  let code: number;
  try {
    code = await runGovernedEvalAnchor();
  } catch (err: unknown) {
    console.error('governed eval anchor crashed:', err);
    code = 1;
  }
  process.exit(code);
}

// Direct-execution guard — run only as the process entry, not on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
