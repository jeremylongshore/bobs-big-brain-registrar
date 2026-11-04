import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scoreFrozenReviewDataset, verifyFrozenReviewDataset } from '../review-agent-frozen.js';
import type { FrozenReviewOptions } from '../review-agent-frozen.js';
import { scoreReviewJudgments, type ReviewLabel } from '../review-agent-judgment.js';

let scratch: string;
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const body = (id: string, expected: ReviewLabel, stratum = 'ordinary') => ({
  schemaVersion: 1,
  id,
  expected,
  stratum,
  input: { candidate: 'PRIVATE-SOURCE-SENTINEL', context: ['PRIVATE-CONTEXT-SENTINEL'] },
  disposition: { kind: 'synthetic' },
});
function fixture() {
  const root = join(scratch, 'dataset');
  mkdirSync(join(root, 'cases'), { recursive: true });
  const rows = [
    body('novel', 'promote'),
    body('uncertain', 'hold'),
    body('bad', 'reject'),
    body('paraphrase', 'reject', 'paraphrase-duplicate'),
  ];
  for (const item of rows) write(join(root, 'cases', `${item.id}.json`), item);
  const manifest = {
    schemaVersion: 1,
    datasetId: 'test',
    kind: 'synthetic',
    revision: 1,
    previousManifestSha256: null as string | null,
    recallFloors: { promote: 1, hold: 1, reject: 1 },
    cases: rows.map((item) => ({
      id: item.id,
      sha256: digest(join(root, 'cases', `${item.id}.json`)),
    })),
  };
  const manifestPath = join(root, 'manifest.json');
  write(manifestPath, manifest);
  const options: FrozenReviewOptions = { root, manifestSha256: digest(manifestPath) };
  const predictionsPath = join(scratch, 'predictions.json');
  const predictions = rows.map((item) => ({ caseId: item.id, label: item.expected }));
  const savePredictions = (selected: unknown = predictions, pin = options.manifestSha256) =>
    write(predictionsPath, { schemaVersion: 1, manifestSha256: pin, predictions: selected });
  savePredictions();
  const repin = () => {
    write(manifestPath, manifest);
    options.manifestSha256 = digest(manifestPath);
  };
  const replaceCase = (id: string, selected: unknown) => {
    write(join(root, 'cases', `${id}.json`), selected);
    manifest.cases.find((item) => item.id === id)!.sha256 = digest(
      join(root, 'cases', `${id}.json`),
    );
    repin();
  };
  return {
    root,
    rows,
    manifest,
    manifestPath,
    options,
    predictionsPath,
    predictions,
    savePredictions,
    repin,
    replaceCase,
  };
}
function appended() {
  const f = fixture();
  const prior = join(scratch, 'approved-prior.json');
  cpSync(f.manifestPath, prior);
  f.options.previous = { manifestPath: prior, sha256: f.options.manifestSha256 };
  f.manifest.revision = 2;
  f.manifest.previousManifestSha256 = f.options.manifestSha256;
  const extra = body('addition', 'reject');
  write(join(f.root, 'cases', 'addition.json'), extra);
  f.manifest.cases.push({ id: extra.id, sha256: digest(join(f.root, 'cases', 'addition.json')) });
  f.repin();
  return f;
}
function snapshot(root: string): unknown {
  return readdirSync(root)
    .sort()
    .map((name) => {
      const path = join(root, name);
      const stat = statSync(path, { bigint: true });
      return {
        name,
        mtime: stat.mtimeNs,
        ctime: stat.ctimeNs,
        data: stat.isDirectory() ? snapshot(path) : readFileSync(path).toString('base64'),
      };
    });
}
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'review-eval-fixture-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('frozen review dataset verification and scoring', () => {
  it.each(['case', 'manifest', 'inventory'])(
    'rejects late %s drift after earlier evidence has been read',
    (kind) => {
      const f = fixture();
      const lastInode = fs.statSync(join(f.root, 'cases', 'paraphrase.json')).ino;
      const originalRead = fs.readSync;
      let mutated = false;
      const spy = vi.spyOn(fs, 'readSync').mockImplementation((...args) => {
        const n = Reflect.apply(originalRead, fs, args) as number;
        if (!mutated && n > 0 && fs.fstatSync(args[0]).ino === lastInode) {
          mutated = true;
          const target =
            kind === 'case'
              ? join(f.root, 'cases', 'novel.json')
              : kind === 'manifest'
                ? f.manifestPath
                : join(f.root, 'cases', 'unlisted.json');
          fs.writeFileSync(
            target,
            kind === 'inventory' ? '{}' : fs.readFileSync(target, 'utf8') + ' ',
          );
        }
        return n;
      });
      syncBuiltinESMExports();
      try {
        expect(() => verifyFrozenReviewDataset(f.options)).toThrow(
          /^Invalid frozen review evaluation evidence$/,
        );
        expect(mutated).toBe(true);
      } finally {
        spy.mockRestore();
        syncBuiltinESMExports();
      }
    },
  );
  it('verifies independently pinned bytes, scores the existing core and emits no source bodies', () => {
    const f = fixture();
    const before = snapshot(f.root);
    expect(verifyFrozenReviewDataset(f.options)).toMatchObject({
      integrity: 'verified',
      kind: 'synthetic',
      caseCount: 4,
      humanAuthorizationVerified: false,
    });
    const scored = scoreFrozenReviewDataset(f.options, f.predictionsPath);
    const { dataset, predictionsSha256, ...metrics } = scored;
    expect(metrics).toEqual(
      scoreReviewJudgments(
        f.rows.map(({ id, expected, stratum }) => ({ id, expected, stratum })),
        f.predictions,
        f.manifest.recallFloors,
      ),
    );
    expect(dataset.manifestSha256).toBe(f.options.manifestSha256);
    expect(predictionsSha256).toBe(digest(f.predictionsPath));
    expect(JSON.stringify(scored)).not.toContain('PRIVATE-');
    expect(snapshot(f.root)).toEqual(before);
  });

  it('retains the human-reviewed declaration without claiming human authentication', () => {
    const f = fixture();
    f.manifest.kind = 'human-reviewed';
    for (const row of f.rows)
      f.replaceCase(row.id, {
        ...row,
        disposition: {
          kind: 'human',
          reviewerIdSha256: 'a'.repeat(64),
          evidenceSha256: 'b'.repeat(64),
        },
      });
    expect(verifyFrozenReviewDataset(f.options)).toMatchObject({
      kind: 'human-reviewed',
      humanAuthorizationVerified: false,
    });
  });

  it('does not accept case and manifest rewrites merely because they agree with each other', () => {
    const f = fixture();
    const independentPin = f.options.manifestSha256;
    f.replaceCase('novel', body('novel', 'reject'));
    expect(() =>
      verifyFrozenReviewDataset({ ...f.options, manifestSha256: independentPin }),
    ).toThrow('Invalid frozen review evaluation evidence');
  });

  it.each([
    'case-byte',
    'manifest-byte',
    'unlisted-case',
    'extra-root-file',
    'missing-case',
    'case-directory',
  ])('refuses %s drift instead of reporting verified evidence', (kind) => {
    const f = fixture();
    const path = join(f.root, 'cases', 'novel.json');
    if (kind === 'case-byte') writeFileSync(path, 'PRIVATE-MUTATED-SENTINEL');
    if (kind === 'manifest-byte')
      writeFileSync(f.manifestPath, readFileSync(f.manifestPath, 'utf8') + ' ');
    if (kind === 'unlisted-case')
      write(join(f.root, 'cases', 'unlisted.json'), body('unlisted', 'reject'));
    if (kind === 'extra-root-file') write(join(f.root, 'unlisted-private.json'), {});
    if (kind === 'missing-case') rmSync(path);
    if (kind === 'case-directory') {
      rmSync(path);
      mkdirSync(path);
    }
    expect(() => verifyFrozenReviewDataset(f.options)).toThrow(
      /^Invalid frozen review evaluation evidence$/,
    );
  });

  it.each([
    'id',
    'label',
    'stratum',
    'input',
    'context',
    'disposition',
    'extra',
    'invalid-json',
    'invalid-utf8',
  ])('rejects a re-pinned malformed case: %s', (kind) => {
    const f = fixture();
    const original = f.rows[0]!;
    const edits: Record<string, unknown> = {
      id: { ...original, id: 'different' },
      label: { ...original, expected: 'private-value' },
      stratum: { ...original, stratum: '../private-path' },
      input: { ...original, input: { candidate: '', context: [] } },
      context: { ...original, input: { candidate: 'private', context: 'private-value' } },
      disposition: {
        ...original,
        disposition: {
          kind: 'human',
          reviewerIdSha256: 'a'.repeat(64),
          evidenceSha256: 'b'.repeat(64),
        },
      },
      extra: { ...original, extra: 'PRIVATE-SENTINEL' },
    };
    if (kind.startsWith('invalid-')) {
      writeFileSync(
        join(f.root, 'cases', 'novel.json'),
        kind === 'invalid-json' ? 'PRIVATE-INVALID-JSON' : Buffer.from([0xff]),
      );
      f.manifest.cases[0]!.sha256 = digest(join(f.root, 'cases', 'novel.json'));
      f.repin();
    } else f.replaceCase('novel', edits[kind]);
    expect(() => verifyFrozenReviewDataset(f.options)).toThrow(
      /^Invalid frozen review evaluation evidence$/,
    );
  });

  it.each([
    'empty',
    'duplicate',
    'path',
    'schema',
    'floor',
    'nonfinite-floor',
    'genesis-parent',
    'revision-parent',
    'extra',
  ])('rejects malformed manifest %s even with its exact external digest', (kind) => {
    const f = fixture();
    if (kind === 'empty') f.manifest.cases = [];
    if (kind === 'duplicate') f.manifest.cases.push(f.manifest.cases[0]!);
    if (kind === 'path') f.manifest.cases[0]!.id = '../private';
    if (kind === 'schema') f.manifest.schemaVersion = 9;
    if (kind === 'floor') f.manifest.recallFloors.reject = 0;
    if (kind === 'nonfinite-floor') f.manifest.recallFloors.reject = Infinity;
    if (kind === 'genesis-parent') f.manifest.previousManifestSha256 = '0'.repeat(64);
    if (kind === 'revision-parent') f.manifest.revision = 2;
    if (kind === 'extra') {
      write(f.manifestPath, { ...f.manifest, private: 'PRIVATE-SENTINEL' });
      f.options.manifestSha256 = digest(f.manifestPath);
    } else f.repin();
    expect(() => verifyFrozenReviewDataset(f.options)).toThrow(
      /^Invalid frozen review evaluation evidence$/,
    );
  });

  it.each(['manifest', 'case', 'cases-directory', 'root', 'ancestor', 'hardlink'])(
    'refuses redirected %s evidence even when the target bytes match',
    (kind) => {
      const f = fixture();
      const original = kind === 'manifest' ? f.manifestPath : join(f.root, 'cases', 'novel.json');
      if (kind === 'root' || kind === 'ancestor') {
        const alias = join(scratch, 'alias');
        symlinkSync(kind === 'root' ? f.root : scratch, alias, 'dir');
        f.options.root = kind === 'root' ? alias : join(alias, 'dataset');
      } else if (kind === 'cases-directory') {
        const target = join(scratch, 'outside-cases');
        cpSync(join(f.root, 'cases'), target, { recursive: true });
        rmSync(join(f.root, 'cases'), { recursive: true });
        symlinkSync(target, join(f.root, 'cases'), 'dir');
      } else {
        const target = join(scratch, 'outside.json');
        cpSync(original, target);
        rmSync(original);
        if (kind === 'hardlink') linkSync(target, original);
        else symlinkSync(target, original);
      }
      expect(() => verifyFrozenReviewDataset(f.options)).toThrow(
        /^Invalid frozen review evaluation evidence$/,
      );
    },
  );

  it.each(['manifest', 'case', 'predictions'])('rejects an oversized %s file', (kind) => {
    const f = fixture();
    const path =
      kind === 'manifest'
        ? f.manifestPath
        : kind === 'case'
          ? join(f.root, 'cases', 'novel.json')
          : f.predictionsPath;
    writeFileSync(path, 'x'.repeat(1024 * 1024 + 1));
    if (kind === 'manifest') f.options.manifestSha256 = digest(path);
    expect(() =>
      kind === 'predictions'
        ? scoreFrozenReviewDataset(f.options, path)
        : verifyFrozenReviewDataset(f.options),
    ).toThrow(/^Invalid frozen review evaluation evidence$/);
  });

  it('bounds aggregate case bytes as well as individual files', () => {
    const f = fixture();
    f.manifest.cases = [];
    for (const path of readdirSync(join(f.root, 'cases'))) rmSync(join(f.root, 'cases', path));
    for (let i = 0; i < 76; i++) {
      const id = `large-${i}`;
      const path = join(f.root, 'cases', `${id}.json`);
      write(path, { ...body(id, 'reject'), input: { candidate: 'x'.repeat(900000), context: [] } });
      f.manifest.cases.push({ id, sha256: digest(path) });
    }
    f.repin();
    expect(() => verifyFrozenReviewDataset(f.options)).toThrow(
      /^Invalid frozen review evaluation evidence$/,
    );
  }, 15000);

  it('requires predictions for this exact manifest and retains missing/HOLD misses', () => {
    const f = fixture();
    f.savePredictions([], '0'.repeat(64));
    expect(() => scoreFrozenReviewDataset(f.options, f.predictionsPath)).toThrow(
      /^Invalid frozen review evaluation evidence$/,
    );
    f.savePredictions([]);
    expect(scoreFrozenReviewDataset(f.options, f.predictionsPath)).toMatchObject({
      passed: false,
      perClass: { promote: { recall: 0 }, hold: { recall: 0 }, reject: { recall: 0 } },
    });
    f.savePredictions(f.predictions.map((p) => ({ ...p, label: 'hold' })));
    expect(scoreFrozenReviewDataset(f.options, f.predictionsPath).passed).toBe(false);
  });

  it.each(['unknown', 'duplicate', 'label', 'extra', 'json', 'symlink'])(
    'rejects %s predictions without copying private data into errors',
    (kind) => {
      const f = fixture();
      if (kind === 'unknown') f.savePredictions([{ caseId: 'PRIVATE-SENTINEL', label: 'reject' }]);
      if (kind === 'duplicate') f.savePredictions([f.predictions[0], f.predictions[0]]);
      if (kind === 'label') f.savePredictions([{ caseId: 'novel', label: 'PRIVATE-SENTINEL' }]);
      if (kind === 'extra')
        write(f.predictionsPath, {
          schemaVersion: 1,
          manifestSha256: f.options.manifestSha256,
          predictions: [],
          private: 'PRIVATE-SENTINEL',
        });
      if (kind === 'json') writeFileSync(f.predictionsPath, 'PRIVATE-SENTINEL');
      if (kind === 'symlink') {
        const target = join(scratch, 'other.json');
        cpSync(f.predictionsPath, target);
        rmSync(f.predictionsPath);
        symlinkSync(target, f.predictionsPath);
      }
      expect(() => scoreFrozenReviewDataset(f.options, f.predictionsPath)).toThrow(
        /^Invalid frozen review evaluation evidence$/,
      );
    },
  );
});

describe('approved append-only manifest continuity', () => {
  it('preserves all prior cases against an independently pinned checkpoint', () => {
    const f = appended();
    const before = snapshot(f.root);
    expect(verifyFrozenReviewDataset(f.options)).toMatchObject({
      revision: 2,
      caseCount: 5,
      previousManifestSha256: f.options.previous!.sha256,
    });
    expect(snapshot(f.root)).toEqual(before);
  });

  it.each([
    'no-prior',
    'wrong-pin',
    'wrong-link',
    'missing-prior',
    'prior-symlink',
    'revision',
    'dataset',
    'kind',
    'floor',
    'delete',
    'reorder',
    'replace-label',
    'no-addition',
  ])('refuses append history violation: %s', (kind) => {
    const f = appended();
    if (kind === 'no-prior') delete f.options.previous;
    if (kind === 'wrong-pin') f.options.previous!.sha256 = '0'.repeat(64);
    if (kind === 'wrong-link') f.manifest.previousManifestSha256 = '0'.repeat(64);
    if (kind === 'missing-prior') rmSync(f.options.previous!.manifestPath);
    if (kind === 'prior-symlink') {
      const target = join(scratch, 'other-prior.json');
      cpSync(f.options.previous!.manifestPath, target);
      rmSync(f.options.previous!.manifestPath);
      symlinkSync(target, f.options.previous!.manifestPath);
    }
    if (kind === 'revision') f.manifest.revision = 4;
    if (kind === 'dataset') f.manifest.datasetId = 'different';
    if (kind === 'kind') f.manifest.kind = 'human-reviewed';
    if (kind === 'floor') f.manifest.recallFloors.reject = 0.9;
    if (kind === 'delete') {
      f.manifest.cases.shift();
      rmSync(join(f.root, 'cases', 'novel.json'));
    }
    if (kind === 'reorder') f.manifest.cases.reverse();
    if (kind === 'replace-label') f.replaceCase('novel', body('novel', 'reject'));
    if (kind === 'no-addition') {
      f.manifest.cases.pop();
      rmSync(join(f.root, 'cases', 'addition.json'));
    }
    f.repin();
    expect(() => verifyFrozenReviewDataset(f.options)).toThrow(
      /^Invalid frozen review evaluation evidence$/,
    );
  });

  it('does not silently ignore a prior checkpoint on a genesis dataset', () => {
    const f = fixture();
    f.options.previous = { manifestPath: f.manifestPath, sha256: f.options.manifestSha256 };
    expect(() => verifyFrozenReviewDataset(f.options)).toThrow(
      /^Invalid frozen review evaluation evidence$/,
    );
  });
});

describe('actual runner process', () => {
  it('the normal workspace build emits a self-contained JavaScript CLI', () => {
    const compiled = fileURLToPath(new URL('../../dist/review-agent-eval-cli.js', import.meta.url));
    const result = spawnSync(process.execPath, [compiled, '--self-test'], {
      encoding: 'utf8',
      timeout: 20000,
      env: { PATH: process.env['PATH'] ?? '' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'synthetic', passed: true });
  }, 30000);
  const cli = fileURLToPath(new URL('../review-agent-eval-cli.ts', import.meta.url));
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env['PATH'] ?? '' },
    });
  it('runs actual self-test children and observes all positive and planted-failure exit statuses', () => {
    const result = run(['--self-test']);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ kind: 'synthetic', passed: true });
    expect(report.checks).toHaveLength(9);
    expect(report.checks.every((row: { passed: boolean }) => row.passed)).toBe(true);
    expect(new Set(report.checks.map((row: { actualExit: number }) => row.actualExit))).toEqual(
      new Set([0, 1, 2]),
    );
  }, 60000);
  it('reports actual invalid-evidence exit without private source text', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'cases', 'novel.json'), 'PRIVATE-SOURCE-SENTINEL');
    const result = run([
      '--verify-manifest',
      '--eval-root',
      f.root,
      '--manifest-sha256',
      f.options.manifestSha256,
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Invalid frozen review evaluation input or evidence. Use --help.\n');
  });
  it.each([
    [],
    ['--unknown'],
    ['--self-test', '--verify-manifest'],
    ['--verify-manifest', '--verify-manifest'],
    ['--score'],
    ['--eval-root', 'x', '--manifest-sha256', 'x', '--previous-manifest', 'x', '--verify-manifest'],
  ])('refuses invalid command usage %j', (...args) => {
    expect(run(args as string[]).status).toBe(2);
  });
});
