import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vitest = join(repo, 'node_modules/vitest/vitest.mjs');
const packages = ['apps', 'packages'].flatMap((group) =>
  readdirSync(join(repo, group)).flatMap((name) => {
    const path = join(group, name);
    const manifest = join(repo, path, 'package.json');
    return existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, 'utf8')).scripts?.test === 'vitest run'
      ? [path]
      : [];
  }),
);

const testHashes = (root: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(root, { withFileTypes: true }).flatMap((entry): [string, string][] => {
      if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) return [];
      const path = join(root, entry.name);
      if (entry.isDirectory()) return Object.entries(testHashes(path));
      return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
        ? [[path, createHash('sha256').update(readFileSync(path)).digest('hex')]]
        : [];
    }),
  );

let discoveryIntegrityFailed = false;

// These children discover actual package files without collecting their modules.
// Execution is confined to one generated synthetic fixture under an owned root.
describe('documented package-cwd test entrypoints', () => {
  it('covers every declared bare package test command', () => {
    expect(packages).toHaveLength(14);
    for (const path of packages) {
      expect(readFileSync(join(repo, path, 'vitest.config.ts'), 'utf8')).toContain(
        "export { default } from '../../vitest.config.js'",
      );
    }
  });

  it.each(packages)(
    'preserves scope, filters and the private baseline for %s',
    (path) => {
      if (discoveryIntegrityFailed)
        throw new Error('Discovery changed source; no further child commands allowed');
      const scratch = mkdtempSync(join(tmpdir(), 'teamkb-live-guard-package-'));
      const log = join(scratch, 'attempts.jsonl');
      const state = join(scratch, 'state.jsonl');
      const report = join(scratch, 'report.json');
      writeFileSync(log, '');
      writeFileSync(state, '');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_OPTIONS: '--import ' + join(repo, 'tests/support/live-collection-preload.mjs'),
        TEAMKB_TEST_SENTINEL_LOG: log,
        TEAMKB_TEST_SENTINEL_STATE: state,
        TEAMKB_TEST_LIVE_LANE: '1',
        TEAMKB_BASE_PATH: join(scratch, 'ambient-brain'),
        TEAMKB_TEST_PACKAGE_AMBIENT_BASE: join(scratch, 'ambient-brain'),
        TEAMKB_TEST_PACKAGE_HOME: process.env['HOME'],
      };
      for (const kind of ['DENSE', 'RERANK', 'RETRIEVAL']) delete env[`TEAMKB_TEST_LIVE_${kind}`];
      const cwd = join(repo, path);
      const run = (args: string[]) =>
        execFileSync(process.execPath, [vitest, ...args], {
          cwd,
          env,
          timeout: 30_000,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      try {
        // Snapshot the package's test sources before EACH discovery command.
        // --json accepts a filename, so filters must precede that optional flag.
        const discover = (filters: string[] = []): { file: string }[] => {
          const before = testHashes(cwd);
          try {
            return JSON.parse(run(['list', ...filters, '--filesOnly', '--json']));
          } finally {
            const after = testHashes(cwd);
            if (JSON.stringify(after) !== JSON.stringify(before)) discoveryIntegrityFailed = true;
            expect(after).toEqual(before);
          }
        };
        const selected = discover();
        expect(selected.length).toBeGreaterThan(0);
        for (const entry of selected) expect(entry.file.startsWith(cwd + '/')).toBe(true);
        const first = selected[0]!.file;
        expect(discover([relative(cwd, first)])).toEqual([{ file: first }]);
        writeFileSync(
          join(scratch, 'baseline.test.ts'),
          `
import { it, expect } from ${JSON.stringify(join(repo, 'node_modules/vitest/dist/index.js'))};
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
it('baseline selected', () => {
  const base = process.env.TEAMKB_BASE_PATH;
  expect(base).toBeTruthy();
  expect(base).not.toBe(process.env.TEAMKB_TEST_PACKAGE_AMBIENT_BASE);
  expect(existsSync(base)).toBe(true);
  expect(existsSync(process.env.TEAMKB_BRAINIGNORE)).toBe(true);
  expect(process.env.TEAMKB_TEST_LIVE_LANE).toBe('0');
  expect(process.env.HOME).toBe(process.env.TEAMKB_TEST_PACKAGE_HOME);
  expect(execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.TEAMKB_BASE_PATH)'], {encoding:'utf8'})).toBe(base);
});
it('must remain filtered', () => { throw new Error('CLI name filter widened'); });
`,
        );
        const args = [
          'run',
          '--config',
          join(cwd, 'vitest.config.ts'),
          '--root',
          scratch,
          '--maxWorkers=1',
          '-t',
          'baseline selected',
          '--reporter=json',
          '--outputFile',
          report,
        ];
        run(args);
        const result = JSON.parse(readFileSync(report, 'utf8'));
        expect(result.numPassedTests).toBe(1);
        expect(result.numPendingTests).toBe(1);
        const states = readFileSync(state, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const created = states.filter((entry) => entry.phase === 'created');
        expect(created).toHaveLength(1);
        for (const entry of created) expect(existsSync(entry.root)).toBe(false);
        const cleaned = states.filter((entry) => entry.phase === 'cleaned');
        expect(cleaned).toHaveLength(1);
        expect(cleaned[0]).toMatchObject({ environmentRestored: true, homeUnchanged: true });
        const runs = states.filter((entry) => entry.phase === 'run-cleaned');
        expect(runs).toHaveLength(1);
        expect(existsSync(runs[0].root)).toBe(false);
        const rejected = spawnSync(process.execPath, [vitest, ...args], {
          cwd,
          env: { ...env, TEAMKB_TEST_LIVE_DENSE: '1' },
          timeout: 30_000,
          encoding: 'utf8',
        });
        expect(rejected.error).toBeUndefined();
        expect(rejected.status).toBe(1);
        expect(JSON.parse(readFileSync(report, 'utf8')).numPassedTests).toBe(0);
        expect(readFileSync(report, 'utf8')).toContain(
          'Explicit live tests require --config vitest.live.config.ts',
        );
        const allRuns = readFileSync(state, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.phase === 'run-cleaned');
        // Global teardown must also clean the run whose setup refused opt-in.
        expect(allRuns).toHaveLength(2);
        for (const entry of allRuns) expect(existsSync(entry.root)).toBe(false);
        expect(readFileSync(log, 'utf8')).toBe('');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
