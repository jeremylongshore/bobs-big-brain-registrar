/**
 * Tests for the `provenance-walk` subcommand (Wave-2 F6): walk one curated
 * memory's provenance chain across the govern/compile boundary and report
 * PASS / FAIL / UNVERIFIABLE per link.
 *
 * Three scenarios matter:
 *   1. End-to-end PASS — a spool-style candidate promoted via the REAL
 *      promoter, with a fabricated spool-manifest sidecar and a fabricated
 *      ICO brain dir (trace event), walks 7/7 PASS and exits 0.
 *   2. Broken link — the manifest sidecars exist but none names the
 *      candidate: the spool-manifest link FAILs and the exit code is 1.
 *   3. Absent brain — the --brain path does not exist: the compile-trace
 *      link is honestly UNVERIFIABLE (not FAIL) and the exit code is 3,
 *      distinct from the broken-chain exit 1.
 *
 * @module __tests__/provenance-walk.test
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { computeContentHash, deriveCandidateId } from '@qmd-team-intent-kb/common';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  createTestDatabase,
} from '@qmd-team-intent-kb/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, type CuratorCliDeps } from '../cli.js';
import { promote } from '../promotion/promoter.js';

import { makeCandidate } from './fixtures.js';

// ---------------------------------------------------------------------------
// Scaffolding (same pattern as verify-corpus-accounting.test.ts)
// ---------------------------------------------------------------------------

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function stdoutText(): string {
  const calls = stdoutSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

function stderrText(): string {
  const calls = stderrSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

function makePipelineResult(candidateId: string): PipelineResult {
  return { candidateId, outcome: 'approved', evaluations: [] };
}

// ---------------------------------------------------------------------------
// Fixture builder — one temp workspace holding brain/ + spool/ + a live
// in-memory store seeded through the REAL candidate-insert + promoter path.
// ---------------------------------------------------------------------------

const REL_PATH = 'wiki/concepts/provenance-walk-fixture.md';
// NOTE: no leading/trailing whitespace — the MemoryCandidate Zod schema trims
// `content` on parse, and the candidate id must address the AS-STORED content.
const BODY = '## Fixture\n\nA compiled page body used to content-address the candidate.';

interface Fixture {
  root: string;
  brainDir: string;
  spoolDir: string;
  db: ReturnType<typeof createTestDatabase>;
  deps: CuratorCliDeps;
  candidate: MemoryCandidate;
  memoryId: string;
}

/**
 * Seed the store exactly the way production does: a spool-shaped candidate
 * (content-addressed UUID-v5 id, source 'import', filePaths[0] = relPath)
 * inserted via CandidateRepository, then promoted via promote(). The spool
 * manifest sidecar and the ICO trace event are fabricated on disk.
 */
function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'provenance-walk-'));
  const brainDir = join(root, 'brain');
  const spoolDir = join(root, 'spool');
  mkdirSync(join(brainDir, 'audit', 'traces'), { recursive: true });
  mkdirSync(spoolDir, { recursive: true });

  // Candidate id derived exactly as ICO derives it: workspaceId is the
  // basename of the brain root; body sha is the sha256 of the page body.
  const bodySha256 = computeContentHash(BODY);
  const candidateId = deriveCandidateId(basename(brainDir), REL_PATH, bodySha256);
  const candidate = makeCandidate({
    id: candidateId,
    source: 'import',
    content: BODY,
    metadata: { filePaths: [REL_PATH], projectContext: 'ico', tags: [] },
  });

  const db = createTestDatabase();
  const candidateRepo = new CandidateRepository(db);
  const memoryRepo = new MemoryRepository(db);
  const auditRepo = new AuditRepository(db);
  const contentHash = computeContentHash(candidate.content);
  candidateRepo.insert(candidate, contentHash);
  const memory = promote(
    { candidate, contentHash, pipelineResult: makePipelineResult(candidate.id) },
    memoryRepo,
    auditRepo,
  );

  // Spool file + manifest sidecar, shaped like ICO's emit (spoolFileSha256
  // pins the file bytes; candidateIds lists the emitted ids).
  const spoolFile = join(spoolDir, 'spool-2026-01-01T000000Z.jsonl');
  const spoolBody = JSON.stringify({ id: candidateId }) + '\n';
  writeFileSync(spoolFile, spoolBody);
  writeFileSync(
    `${spoolFile}.manifest.json`,
    JSON.stringify({
      schemaVersion: '1',
      emittedCount: 1,
      spoolFile: 'spool-2026-01-01T000000Z.jsonl',
      spoolFileSha256: createHash('sha256').update(spoolBody, 'utf8').digest('hex'),
      candidateIds: [candidateId],
    }),
  );

  // One hash-chained ICO trace event referencing the compiled page.
  writeFileSync(
    join(brainDir, 'audit', 'traces', '2026-01-01.jsonl'),
    JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      event_type: 'compile.summarize',
      event_id: 'fixture-event-1',
      payload: { sourceId: 'fixture-source', outputPath: REL_PATH },
      prev_hash: 'a'.repeat(64),
    }) + '\n',
  );

  const deps: CuratorCliDeps = { createDb: () => db };
  return { root, brainDir, spoolDir, db, deps, candidate, memoryId: memory.id };
}

function walkArgs(f: Fixture, overrides?: { brainDir?: string }): string[] {
  return [
    'provenance-walk',
    '--memory-id',
    f.memoryId,
    '--db',
    join(f.root, 'teamkb.db'), // presence-only: deps.createDb ignores the path
    '--brain',
    overrides?.brainDir ?? f.brainDir,
    '--spool',
    f.spoolDir,
    '--json',
  ];
}

interface WalkEnvelope {
  memoryId: string;
  links: Array<{ link: string; status: string; evidence: string }>;
  passCount: number;
  failCount: number;
  unverifiableCount: number;
  exitCode: number;
}

function parseEnvelope(): WalkEnvelope {
  return JSON.parse(stdoutText()) as WalkEnvelope;
}

function linkStatus(env: WalkEnvelope, name: string): string | undefined {
  return env.links.find((l) => l.link === name)?.status;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('curator-cli provenance-walk', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('walks the full chain PASS end-to-end and exits 0', async () => {
    const code = await dispatch(walkArgs(fixture), fixture.deps);

    expect(code).toBe(0);
    const env = parseEnvelope();
    expect(env.memoryId).toBe(fixture.memoryId);
    expect(env.failCount).toBe(0);
    expect(env.unverifiableCount).toBe(0);
    expect(env.passCount).toBe(7);
    for (const name of [
      'memory-row',
      'memory-id-derivation',
      'promotion-receipt',
      'candidate-row',
      'candidate-id-derivation',
      'spool-manifest',
      'compile-trace',
    ]) {
      expect(linkStatus(env, name)).toBe('PASS');
    }
  });

  it('FAILs the spool-manifest link (exit 1) when no manifest names the candidate', async () => {
    // Break exactly one link: manifests exist, but none lists this candidate.
    const spoolFile = join(fixture.spoolDir, 'spool-2026-01-01T000000Z.jsonl');
    writeFileSync(
      `${spoolFile}.manifest.json`,
      JSON.stringify({
        schemaVersion: '1',
        emittedCount: 1,
        spoolFile: 'spool-2026-01-01T000000Z.jsonl',
        spoolFileSha256: 'f'.repeat(64),
        candidateIds: ['00000000-0000-5000-8000-000000000000'],
      }),
    );

    const code = await dispatch(walkArgs(fixture), fixture.deps);

    expect(code).toBe(1);
    const env = parseEnvelope();
    expect(linkStatus(env, 'spool-manifest')).toBe('FAIL');
    expect(env.failCount).toBe(1);
    // The govern-side links are unaffected by the broken bridge.
    expect(linkStatus(env, 'memory-row')).toBe('PASS');
    expect(linkStatus(env, 'promotion-receipt')).toBe('PASS');
  });

  it('reports compile-trace UNVERIFIABLE (exit 3, distinct from FAIL) when the brain dir is absent', async () => {
    // The CI shape: the brain root path is well-formed (basename 'brain', so
    // the workspaceId derivation still holds) but the directory does not
    // exist on this host. That is absence of evidence, not contradiction.
    const code = await dispatch(
      walkArgs(fixture, { brainDir: join(fixture.root, 'nowhere', 'brain') }),
      fixture.deps,
    );

    expect(code).toBe(3);
    const env = parseEnvelope();
    expect(linkStatus(env, 'compile-trace')).toBe('UNVERIFIABLE');
    expect(env.failCount).toBe(0);
    expect(env.unverifiableCount).toBe(1);
    // Everything the store can still back stays PASS.
    expect(linkStatus(env, 'memory-row')).toBe('PASS');
    expect(linkStatus(env, 'candidate-id-derivation')).toBe('PASS');
    expect(linkStatus(env, 'spool-manifest')).toBe('PASS');
  });

  it('FAILs the memory-row link (exit 1) for an unknown memory id', async () => {
    const code = await dispatch(
      [
        'provenance-walk',
        '--memory-id',
        'does-not-exist',
        '--db',
        join(fixture.root, 'teamkb.db'),
        '--brain',
        fixture.brainDir,
        '--spool',
        fixture.spoolDir,
        '--json',
      ],
      fixture.deps,
    );

    expect(code).toBe(1);
    const env = parseEnvelope();
    expect(linkStatus(env, 'memory-row')).toBe('FAIL');
  });

  it('refuses to run without --db (exit 2)', async () => {
    const code = await dispatch(['provenance-walk', '--memory-id', fixture.memoryId], fixture.deps);
    expect(code).toBe(2);
    expect(stderrText()).toContain('missing required flag: --db');
  });

  it('refuses to run without --memory-id (exit 2)', async () => {
    const code = await dispatch(
      ['provenance-walk', '--db', join(fixture.root, 'teamkb.db')],
      fixture.deps,
    );
    expect(code).toBe(2);
    expect(stderrText()).toContain('missing required flag: --memory-id');
  });
});
