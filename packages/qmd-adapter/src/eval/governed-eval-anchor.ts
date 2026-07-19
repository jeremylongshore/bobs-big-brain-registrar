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
import { reindex } from '../reindex/reindex.js';
import { runEval } from './run-eval.js';
import { stratify, formatStratifiedReport } from './stratified-report.js';
import type { StratifiedReport } from './stratified-report.js';
import { qmdRetrievalFn } from './qmd-retrieval.js';
import { GOVERNED_BRAIN_V1_DATASET } from './datasets/governed-brain-v1.js';
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
  /** Absolute default path of the frozen tarball on the eval box (override: GOVERNED_EVAL_SNAPSHOT). */
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

/** Build a temp index over `exportDir` and run the full governed-brain-v1 set. */
async function evalCorpus(
  exportDir: string,
  backendLabel: string,
): Promise<
  { ok: true; sr: StratifiedReport; perQuery: EvalPerQuery[] } | { ok: false; reason: string }
> {
  const adapter = new QmdAdapter({
    tenantId: ANCHOR_TENANT,
    exportDir,
    timeout: ANCHOR_QMD_TIMEOUT_MS,
  });
  const built = await reindex(adapter);
  if (!built.ok) {
    return { ok: false, reason: `index build failed: ${built.error.code}: ${built.error.message}` };
  }
  const retrieve = qmdRetrievalFn(adapter, ANCHOR_TENANT, 'curated');
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
  const tarballPath = process.env['GOVERNED_EVAL_SNAPSHOT'] ?? lock.tarballPath;

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
