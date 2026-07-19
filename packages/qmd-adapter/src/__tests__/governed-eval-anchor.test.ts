/**
 * Unit tests for the governed eval anchor's pure logic (GSB Track C1):
 * snapshot lock verification (SHA-256 pin, fail-closed) and per-stratum floor
 * comparison. The full harness needs the private frozen snapshot + the qmd
 * binary and is box-only — CI never runs it, so these tests cover exactly the
 * logic CI CAN verify, using a tiny fixture tarball built in-test (skipped
 * where tar/zstd are unavailable).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  checkFloors,
  proposeFloor,
  sha256File,
  verifySnapshotAgainstLock,
  type SnapshotLock,
} from '../eval/governed-eval-anchor.js';
import type { StratifiedReport, StratumMetrics } from '../eval/stratified-report.js';

const tmpRoots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'governed-anchor-test-'));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function lockFor(path: string, sha256: string): SnapshotLock {
  return {
    tarballPath: path,
    sha256,
    createdAtUtc: '2026-07-19T00:00:00Z',
    fileCount: 2,
    corpusNote: 'test fixture',
  };
}

function zstdTarAvailable(): boolean {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('sha256File / verifySnapshotAgainstLock', () => {
  it('computes the same SHA-256 as node:crypto over the bytes', () => {
    const dir = tmp();
    const p = join(dir, 'blob.bin');
    writeFileSync(p, 'governed anchor fixture bytes');
    const expected = createHash('sha256').update(readFileSync(p)).digest('hex');
    expect(sha256File(p)).toBe(expected);
  });

  it('accepts a tarball whose hash matches the lock', () => {
    const dir = tmp();
    const p = join(dir, 'snap.tar.zst');
    writeFileSync(p, 'pretend-tarball-contents');
    const verdict = verifySnapshotAgainstLock(lockFor(p, sha256File(p)), p);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.sha256).toBe(sha256File(p));
  });

  it('refuses (fail-closed) when the tarball bytes drift from the locked hash', () => {
    const dir = tmp();
    const p = join(dir, 'snap.tar.zst');
    writeFileSync(p, 'original bytes');
    const lock = lockFor(p, sha256File(p));
    writeFileSync(p, 'tampered bytes'); // corpus changed after the freeze
    const verdict = verifySnapshotAgainstLock(lock, p);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/mismatch/i);
  });

  it('refuses when the tarball is missing entirely', () => {
    const dir = tmp();
    const verdict = verifySnapshotAgainstLock(
      lockFor(join(dir, 'nope.tar.zst'), 'deadbeef'),
      join(dir, 'nope.tar.zst'),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/not found/);
  });

  it.skipIf(!zstdTarAvailable())(
    'verifies a REAL tiny zstd tarball built in-test (round-trip)',
    () => {
      const dir = tmp();
      const corpus = join(dir, 'kb-export', 'curated');
      mkdirSync(corpus, { recursive: true });
      writeFileSync(join(corpus, 'a.md'), '# doc a\n');
      writeFileSync(join(corpus, 'b.md'), '# doc b\n');
      const tarball = join(dir, 'kb-export-frozen-test.tar.zst');
      execFileSync('tar', ['-C', dir, '--zstd', '-cf', tarball, 'kb-export']);

      const good = verifySnapshotAgainstLock(lockFor(tarball, sha256File(tarball)), tarball);
      expect(good.ok).toBe(true);

      const bad = verifySnapshotAgainstLock(lockFor(tarball, '0'.repeat(64)), tarball);
      expect(bad.ok).toBe(false);
    },
  );
});

function stratum(name: string, recall: number, n = 10): StratumMetrics {
  return { stratum: name, queryCount: n, meanRecallAtK: recall, meanNdcgAtK: recall, mrr: recall };
}

function reportWith(overall: number, byKind: StratumMetrics[]): StratifiedReport {
  return {
    dataset: 'governed-brain-v1',
    backend: 'test',
    k: 10,
    overall: stratum(
      'overall',
      overall,
      byKind.reduce((s, k) => s + k.queryCount, 0),
    ),
    byKind,
  };
}

describe('checkFloors', () => {
  const floors = { overall: 0.8, lexical: 0.9, semantic: 0.7 };

  it('holds when every stratum is at or above floor − epsilon', () => {
    const sr = reportWith(0.8, [stratum('lexical', 0.8995), stratum('semantic', 0.71)]);
    const checks = checkFloors(sr, floors, 0.001);
    expect(checks.every((c) => c.held)).toBe(true);
    // 0.8995 ≥ 0.9 − 0.001 — inside the epsilon slack, not a regression.
    expect(checks.find((c) => c.stratum === 'lexical')?.held).toBe(true);
  });

  it('flags exactly the regressed stratum', () => {
    const sr = reportWith(0.8, [stratum('lexical', 0.95), stratum('semantic', 0.5)]);
    const checks = checkFloors(sr, floors, 0.001);
    const failed = checks.filter((c) => !c.held);
    expect(failed.map((c) => c.stratum)).toEqual(['semantic']);
    expect(failed[0]?.floor).toBeCloseTo(0.699, 10);
  });

  it('treats a stratum missing from the report as measured 0 (regression, not pass)', () => {
    const sr = reportWith(0.9, [stratum('lexical', 0.95)]); // semantic vanished
    const checks = checkFloors(sr, floors, 0.001);
    const semantic = checks.find((c) => c.stratum === 'semantic');
    expect(semantic?.measured).toBe(0);
    expect(semantic?.held).toBe(false);
  });

  it('checks the overall floor against the report overall row', () => {
    const sr = reportWith(0.5, [stratum('lexical', 0.95), stratum('semantic', 0.95)]);
    const checks = checkFloors(sr, { overall: 0.8 }, 0.001);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.held).toBe(false);
  });
});

describe('proposeFloor', () => {
  it('captures overall + every observed stratum, rounded to 4 places', () => {
    const sr = reportWith(0.81234567, [
      stratum('lexical', 0.9999999),
      stratum('semantic', 0.7123449),
    ]);
    const proposed = proposeFloor(sr, 'abc123');
    expect(proposed.dataset).toBe('governed-brain-v1');
    expect(proposed.snapshotSha256).toBe('abc123');
    expect(proposed.floors['overall']).toBe(0.8123);
    expect(proposed.floors['lexical']).toBe(1);
    expect(proposed.floors['semantic']).toBe(0.7123);
    expect(proposed.epsilon).toBeGreaterThan(0);
  });
});
