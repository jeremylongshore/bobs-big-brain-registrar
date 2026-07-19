#!/usr/bin/env -S node --experimental-strip-types
/**
 * ci/emit-evidence/emit-evidence.ts — run this repo's three REAL CI-blocking
 * evals and shape their verdicts into signed-ready evidence for the
 * intent-eval-dashboard reports hub (labs.intentsolutions.io, repo row key
 * `qmd`).
 *
 * ── Why this lives in `ci/emit-evidence/`, NOT a workspace package ──
 *
 * This emitter is a CI-only artifact producer with its own pinned dependency
 * (`@intentsolutions/core` — the kernel validators, pinned to the EXACT
 * version the dashboard verifies with). It has its own private, non-workspace
 * `package.json` + lockfile so the workspace packages are untouched — in
 * particular `packages/eval-surface` stays PURE (it measures; it does not
 * emit or sign). Nothing under `ci/` ships anywhere. The pattern (and the
 * canonicalisation contract) mirrors the proven emitters in
 * claude-code-plugins and j-rig-skill-binary-eval.
 *
 * ── What it attests (honest, no fake evidence) ──
 *
 * One gate-result/v1 row PER CI GATE, produced by actually RUNNING each gate
 * as a subprocess (the same commands ci.yml runs) after the workspace is
 * installed + built:
 *
 *   provenance-integrity — pnpm --filter @qmd-team-intent-kb/eval-surface provenance:ci
 *   govern-decision      — pnpm --filter @qmd-team-intent-kb/eval-surface govern:ci
 *   retrieval-ratchet    — pnpm --filter @qmd-team-intent-kb/qmd-adapter eval:retrieval:ci
 *                          (needs the pinned workspace `qmd` bin on PATH; this
 *                          script prepends <repo>/node_modules/.bin exactly
 *                          like ci.yml's retrieval-eval job)
 *
 * Exit 0 → pass; nonzero → fail (first lines of output become gate_reasons).
 * The ratchet's documented exit 2 (qmd unavailable / index answered nothing)
 * becomes an HONEST `gate_decision: "error"` row with failure_mode
 * `eval-runner-unavailable` — never a fake pass or fail.
 *
 * The policy a row attests under is the evaluator entry-point source set:
 * `policy_hash` is the sha256 over the concatenated bytes of the three gate
 * sources (POLICY_SOURCE_FILES, fixed order), so any auditor can recompute it
 * from the tree at `commit_sha` (`sha256(cat f1 f2 f3)`).
 *
 * Outputs:
 *   build/evidence/bundle-<i>.json          — CANONICAL EvidenceBundle bytes
 *   build/evidence/gate-result-<i>.json     — the gate-result/v1 predicate body
 *   build/evidence/manifest-skeleton.json   — for ci/emit-evidence/assemble-manifest.ts
 *
 * Signing + Rekor + final report-manifest.json assembly happen in CI
 * (.github/workflows/emit-evidence.yml). This script does NO crypto and
 * writes only to the gitignored `build/` dir. Run it from the repo root.
 *
 * Usage:
 *   node --experimental-strip-types ci/emit-evidence/emit-evidence.ts \
 *     [--out build/evidence] [--ref refs/heads/main] [--self-check]
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  GateResultV1Schema,
  GATE_RESULT_V1_URI,
} from '@intentsolutions/core/validators/v1/gate-result-v1';
import { EvidenceBundleSchema } from '@intentsolutions/core/validators/v1/evidence-bundle';

// Derived from the runtime environment so the manifest's signing subject
// ALWAYS matches the cosign OIDC certificate identity, which CI derives from
// ${GITHUB_REPOSITORY} — a repo rename can never split the two. The fallback
// (current slug, post-2026-07-19 rename) only applies outside GitHub Actions.
const GITHUB_REPO = process.env['GITHUB_REPOSITORY'] || 'jeremylongshore/bobs-big-brain-registrar';
const REPO_KEY = 'qmd';
const WORKFLOW_FILE = 'emit-evidence.yml';

/**
 * The evaluator entry-point sources the emitted rows attest under, in FIXED
 * order. policy_hash = sha256 of these files' bytes concatenated in this
 * order — recomputable by any auditor from the tree at commit_sha.
 */
const POLICY_SOURCE_FILES = [
  'packages/eval-surface/scripts/ci-provenance-integrity.ts',
  'packages/eval-surface/scripts/ci-govern-decision.ts',
  'packages/qmd-adapter/src/eval/ci-retrieval-ratchet.ts',
] as const;

interface GateSpec {
  readonly gateName: string;
  /** argv the gate runs as (identical to the ci.yml invocation). */
  readonly command: readonly string[];
  /** Single coverage dimension this gate measures. */
  readonly dimension: string;
  /** Exit codes with a documented non-fail meaning (ratchet exit 2). */
  readonly unavailableExitCode?: number;
}

const GATES: readonly GateSpec[] = [
  {
    gateName: 'provenance-integrity',
    command: ['pnpm', '--filter', '@qmd-team-intent-kb/eval-surface', 'provenance:ci'],
    dimension: 'provenance-integrity',
  },
  {
    gateName: 'govern-decision',
    command: ['pnpm', '--filter', '@qmd-team-intent-kb/eval-surface', 'govern:ci'],
    dimension: 'govern-decision-efficacy',
  },
  {
    gateName: 'retrieval-ratchet',
    command: ['pnpm', '--filter', '@qmd-team-intent-kb/qmd-adapter', 'eval:retrieval:ci'],
    dimension: 'retrieval-recall',
    // ci-retrieval-ratchet.ts documents exit 2 = qmd unavailable / empty
    // index (misconfig) — an honest `error`, never a fake pass/fail.
    unavailableExitCode: 2,
  },
];

interface GateOutcome {
  readonly gateName: string;
  readonly gateVersion: string;
  readonly decision: 'pass' | 'fail' | 'advisory' | 'error';
  readonly reasons: readonly string[];
  readonly dimensionsEvaluated: readonly string[];
  readonly dimensionsSkipped: readonly string[];
  readonly advisorySeverity?: 'info' | 'warn' | 'error';
  readonly failureMode?: string;
}

interface EmitContext {
  readonly nowIso: string;
  readonly nowMs: number;
  readonly commitSha: string;
  readonly policyHashHex: string;
  readonly runnerVersion: string;
  readonly rand16: () => Uint8Array;
}

// ── Canonicalisation (MUST match the dashboard's content-address.ts) ──

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortDeep(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/** Canonical JSON string (sorted keys, no whitespace) — dashboard-identical. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sha256Hex(s: string | Buffer): string {
  return createHash('sha256')
    .update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s)
    .digest('hex');
}

/** Generate a kernel-valid UUIDv7 from a 16-byte source + ms timestamp. */
export function uuidv7(nowMs: number, rand: Uint8Array): string {
  const b = Buffer.from(rand.slice(0, 16));
  const ts = BigInt(nowMs);
  b[0] = Number((ts >> 40n) & 0xffn);
  b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn);
  b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);
  b[5] = Number(ts & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A built row: the kernel-valid bundle + its canonical bytes + the gate body. */
export interface EmitRow {
  readonly bundle: unknown;
  readonly canonicalBundle: string;
  readonly gateResult: unknown;
  readonly sourceSha: string;
}

function policyRef(ctx: EmitContext): string {
  return `sha256:${ctx.policyHashHex}:${POLICY_SOURCE_FILES.join(',')}`;
}

/**
 * Build + kernel-validate a gate-result/v1 body for one gate outcome. Throws
 * (fail closed) if the result is not kernel-schema-valid.
 */
export function buildGateResult(o: GateOutcome, ctx: EmitContext): Record<string, unknown> {
  const gateId = `${REPO_KEY}:ci:${o.gateName}`;
  const policyHash = `sha256:${ctx.policyHashHex}`;
  const inputHash = `sha256:${sha256Hex(`${ctx.commitSha}:${o.gateName}:${policyHash}`)}`;
  const body: Record<string, unknown> = {
    gate_id: gateId,
    gate_name: o.gateName,
    gate_version: o.gateVersion,
    gate_decision: o.decision,
    gate_reasons: [...o.reasons],
    coverage: {
      dimensions_evaluated: [...o.dimensionsEvaluated],
      dimensions_skipped: [...o.dimensionsSkipped],
    },
    policy_ref: policyRef(ctx),
    policy_hash: policyHash,
    input_hash: inputHash,
    evaluated_at: ctx.nowIso,
    runner: `qmd-emit@${ctx.runnerVersion}`,
    commit_sha: ctx.commitSha,
    ...(o.advisorySeverity !== undefined ? { advisory_severity: o.advisorySeverity } : {}),
    ...(o.failureMode !== undefined ? { failure_mode: o.failureMode } : {}),
  };
  GateResultV1Schema.parse(body); // fail-closed
  return body;
}

/**
 * Wrap a gate-result body in a kernel EvidenceBundle. Throws if the bundle is
 * not kernel-schema-valid.
 */
export function buildEvidenceBundle(
  gateResult: Record<string, unknown>,
  ctx: EmitContext,
): Record<string, unknown> {
  const grHashHex = sha256Hex(stableStringify(gateResult));
  const inputHash = String(gateResult['input_hash']);
  const subjectDigest = inputHash.startsWith('sha256:')
    ? inputHash.slice('sha256:'.length)
    : inputHash;
  const bundle: Record<string, unknown> = {
    id: uuidv7(ctx.nowMs, ctx.rand16()),
    eval_run_id: uuidv7(ctx.nowMs, ctx.rand16()),
    created_at: ctx.nowIso,
    predicate_uri_set: [GATE_RESULT_V1_URI],
    row_count: 1,
    subject_set: [{ name: String(gateResult['gate_id']), digest: { sha256: subjectDigest } }],
    storage_key: `sha256:${grHashHex}`,
    signing_mode: 'rekor_production',
    rekor_log_indices: [], // real index lives in the sigstore Bundle
    verification_status: 'unverified', // the dashboard re-verifies; we don't self-attest
    verification_last_checked_at: ctx.nowIso,
  };
  EvidenceBundleSchema.parse(bundle); // fail-closed
  return bundle;
}

/** Build all rows from outcomes. */
export function buildRows(outcomes: readonly GateOutcome[], ctx: EmitContext): EmitRow[] {
  return outcomes.map((o) => {
    const gateResult = buildGateResult(o, ctx);
    const bundle = buildEvidenceBundle(gateResult, ctx);
    return {
      bundle,
      canonicalBundle: stableStringify(bundle),
      gateResult,
      sourceSha: ctx.commitSha,
    };
  });
}

/** The manifest skeleton CI signs + assembles into the final report-manifest.json. */
export interface ManifestSkeleton {
  readonly repo: string;
  readonly signing: {
    readonly issuer: string;
    readonly subject: string;
    readonly workflowRef: string;
  };
  readonly rows: readonly {
    readonly bundleFile: string;
    readonly gateResults: readonly unknown[];
    readonly sourceSha: string;
  }[];
}

/**
 * The OIDC signing claims this CI run will assert. The emit workflow runs on
 * push-to-main plus a main-only dispatch guard, so `ref` is always
 * `refs/heads/main` in CI — exactly the claims the dashboard pins for the
 * `qmd` row.
 */
export function signingClaims(ref: string): ManifestSkeleton['signing'] {
  return {
    issuer: 'https://token.actions.githubusercontent.com',
    subject: `repo:${GITHUB_REPO}:ref:${ref}`,
    workflowRef: `${GITHUB_REPO}/.github/workflows/${WORKFLOW_FILE}@${ref}`,
  };
}

/** Write all emit artifacts under `outDir`. Returns the skeleton written. */
export function writeEmit(rows: readonly EmitRow[], ref: string, outDir: string): ManifestSkeleton {
  mkdirSync(outDir, { recursive: true });
  const skeletonRows = rows.map((row, i) => {
    const bundleFile = `bundle-${i}.json`;
    writeFileSync(join(outDir, bundleFile), row.canonicalBundle, 'utf8');
    writeFileSync(join(outDir, `gate-result-${i}.json`), stableStringify(row.gateResult), 'utf8');
    return { bundleFile, gateResults: [row.gateResult], sourceSha: row.sourceSha };
  });
  const skeleton: ManifestSkeleton = {
    repo: REPO_KEY,
    signing: signingClaims(ref),
    rows: skeletonRows,
  };
  writeFileSync(join(outDir, 'manifest-skeleton.json'), JSON.stringify(skeleton, null, 2), 'utf8');
  return skeleton;
}

// ── Gate execution (subprocess-level, same commands as ci.yml) ──

/** Non-empty, non-pnpm-echo output lines, each bounded to 300 chars. */
function meaningfulLines(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('>'))
    .map((l) => l.slice(0, 300));
}

/** First meaningful output lines — the diagnostic head for fail/error rows. */
function headLines(output: string, max: number): string[] {
  return meaningfulLines(output).slice(0, max);
}

/** Last meaningful output lines — the result summary for pass rows. */
function tailLines(output: string, max: number): string[] {
  return meaningfulLines(output).slice(-max);
}

/**
 * Run one CI gate as a subprocess and map its exit code to an honest verdict:
 * 0 → pass; the gate's documented "unavailable" exit code → error with
 * failure_mode `eval-runner-unavailable`; any other nonzero → fail; spawn
 * failure → error. Never fabricates a pass.
 */
export function runGate(spec: GateSpec, repoRoot: string): GateOutcome {
  const binPath = join(repoRoot, 'node_modules', '.bin');
  // Same discipline as ci.yml's retrieval-eval job: the pinned workspace
  // bins (notably `qmd`) resolve ahead of any stray system copy.
  const env = { ...process.env, PATH: `${binPath}${delimiter}${process.env['PATH'] ?? ''}` };
  const res = spawnSync(spec.command[0]!, spec.command.slice(1), {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const base = {
    gateName: spec.gateName,
    gateVersion: '1.0.0',
    dimensionsEvaluated: [spec.dimension],
    dimensionsSkipped: [] as string[],
  };
  if (res.error !== undefined || res.status === null) {
    return {
      ...base,
      decision: 'error',
      reasons: [
        `gate runner failed to execute: ${res.error?.message ?? 'terminated by signal'}`,
        ...headLines(output, 3),
      ],
      dimensionsEvaluated: [],
      dimensionsSkipped: [spec.dimension],
      failureMode: 'eval-runner-error',
    };
  }
  if (res.status === 0) {
    // The evals print their result summary last — that is the pass evidence.
    return {
      ...base,
      decision: 'pass',
      reasons: tailLines(output, 3),
    };
  }
  if (spec.unavailableExitCode !== undefined && res.status === spec.unavailableExitCode) {
    return {
      ...base,
      decision: 'error',
      reasons: [
        `eval runner unavailable (exit ${res.status}): the gate could not run — not a pass, not a fail`,
        ...headLines(output, 4),
      ],
      dimensionsEvaluated: [],
      dimensionsSkipped: [spec.dimension],
      failureMode: 'eval-runner-unavailable',
    };
  }
  return {
    ...base,
    decision: 'fail',
    reasons: [`gate exited ${res.status}`, ...headLines(output, 5)],
    failureMode: 'ci-gate-fail',
  };
}

export function runGates(repoRoot: string): GateOutcome[] {
  return GATES.map((spec) => {
    console.log(`── running gate ${spec.gateName}: ${spec.command.join(' ')}`);
    const outcome = runGate(spec, repoRoot);
    console.log(`   → ${outcome.decision}`);
    return outcome;
  });
}

// ── Policy hash (auditor-recomputable from the tree at commit_sha) ──

export function computePolicyHashHex(repoRoot: string): string {
  const h = createHash('sha256');
  for (const rel of POLICY_SOURCE_FILES) {
    h.update(readFileSync(join(repoRoot, rel)));
  }
  return h.digest('hex');
}

// ── Self-check (locally-runnable correctness proof) ──

function selfCheck(): void {
  const ctx = synthCtx();
  const outcomes: GateOutcome[] = [
    {
      gateName: 'provenance-integrity',
      gateVersion: '1.0.0',
      decision: 'pass',
      reasons: ['provenance-integrity smoke passed on the throwaway brain'],
      dimensionsEvaluated: ['provenance-integrity'],
      dimensionsSkipped: [],
    },
    {
      gateName: 'govern-decision',
      gateVersion: '1.0.0',
      decision: 'fail',
      reasons: ['gate exited 1', 'undocumented false-negative: split-key case'],
      dimensionsEvaluated: ['govern-decision-efficacy'],
      dimensionsSkipped: [],
      failureMode: 'ci-gate-fail',
    },
    {
      gateName: 'retrieval-ratchet',
      gateVersion: '1.0.0',
      decision: 'error',
      reasons: [
        'eval runner unavailable (exit 2): the gate could not run — not a pass, not a fail',
      ],
      dimensionsEvaluated: [],
      dimensionsSkipped: ['retrieval-recall'],
      failureMode: 'eval-runner-unavailable',
    },
  ];
  const rows = buildRows(outcomes, ctx); // throws if any artifact is kernel-invalid
  for (const row of rows) {
    if (stableStringify(JSON.parse(row.canonicalBundle)) !== row.canonicalBundle) {
      throw new Error('canonical bundle is not stable under re-canonicalisation');
    }
  }
  if (rows.length !== 3) throw new Error('expected 3 rows');
  console.log(`self-check OK: ${rows.length} kernel-valid, canonical-stable rows built`);
}

function synthCtx(): EmitContext {
  let n = 0;
  return {
    nowIso: '2026-07-16T00:00:00.000Z',
    nowMs: 1783900800000,
    commitSha: 'a'.repeat(40),
    policyHashHex: 'c'.repeat(64),
    runnerVersion: '0.1.0',
    // Deterministic, non-random 16-byte source so self-check output is stable.
    rand16: () => {
      n += 1;
      return Uint8Array.from(Array.from({ length: 16 }, (_v, i) => (n * 31 + i) & 0xff));
    },
  };
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '0'.repeat(40);
  }
}

function packageVersion(repoRoot: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'ci', 'emit-evidence', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function ciCtx(repoRoot: string): EmitContext {
  // One Date instance: the uuidv7 timestamp bits and created_at/evaluated_at
  // must agree — separate Date.now()/toISOString() calls could straddle a tick.
  const now = new Date();
  return {
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
    commitSha: gitSha(),
    policyHashHex: computePolicyHashHex(repoRoot),
    runnerVersion: packageVersion(repoRoot),
    rand16: () => Uint8Array.from(randomBytes(16)),
  };
}

function parseArgs(argv: readonly string[]): { out: string; ref: string; selfCheck: boolean } {
  let out = 'build/evidence';
  let ref = process.env['GITHUB_REF'] ?? 'refs/heads/main';
  let sc = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[i + 1] ?? out;
      i++;
    } else if (argv[i] === '--ref') {
      ref = argv[i + 1] ?? ref;
      i++;
    } else if (argv[i] === '--self-check') {
      sc = true;
    }
  }
  return { out, ref, selfCheck: sc };
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.selfCheck) {
    selfCheck();
    return 0;
  }
  const repoRoot = process.cwd();
  const ctx = ciCtx(repoRoot);
  const outcomes = runGates(repoRoot);
  const rows = buildRows(outcomes, ctx);
  writeEmit(rows, args.ref, args.out);
  console.log(
    `emit-evidence OK: ${rows.length} kernel-valid gate-result/v1 row(s) written to ${args.out}\n` +
      `  decisions: ${outcomes.map((o) => `${o.gateName}=${o.decision}`).join(', ')}\n` +
      `  next (CI): cosign sign-blob each bundle-<i>.json -> assemble-manifest.ts -> report-manifest.json`,
  );
  return 0;
}

// Only run when invoked directly (not when imported by a sibling assembler).
const invokedDirectly = process.argv[1]?.endsWith('emit-evidence.ts') === true;
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error(
      'emit-evidence FAILED (fail-closed):',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}
