import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const files = ['dense-live-integration', 'rerank-live-integration', 'eval-retrieval-live'].map(
  (name) => `packages/qmd-adapter/src/__tests__/${name}.test.ts`,
);
const vitest = join(repo, 'node_modules/vitest/vitest.mjs');

describe('explicit live suite collection boundary', () => {
  it.each([undefined, 'false', 'inherited-marker'])(
    'never probes available ambient state without exact opt-in (%s)',
    (flag) => {
      const scratch = mkdtempSync(join(tmpdir(), 'teamkb-live-guard-'));
      const log = join(scratch, 'attempts.jsonl');
      const report = join(scratch, 'report.json');
      const state = join(scratch, 'state.jsonl');
      writeFileSync(state, '');
      writeFileSync(log, '');
      for (const path of ['bin', 'brain/kb-export', 'brain/qmd-index/intent-solutions'])
        mkdirSync(join(scratch, path), { recursive: true });
      // Merely available executable/index fixtures must not activate live work.
      const qmd = join(scratch, 'bin/qmd');
      writeFileSync(qmd, '#!/bin/sh\nprintf "synthetic qmd 2.5.3\\n"\n', { mode: 0o700 });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TEAMKB_TEST_SENTINEL_LOG: log,
        TEAMKB_TEST_SENTINEL_STATE: state,
        NODE_OPTIONS: '--import ' + join(repo, 'tests/support/live-collection-preload.mjs'),
        TEAMKB_BASE_PATH: join(scratch, 'brain'),
        PATH: join(scratch, 'bin') + ':' + process.env['PATH'],
      };
      for (const kind of ['DENSE', 'RERANK', 'RETRIEVAL']) {
        const key = `TEAMKB_TEST_LIVE_${kind}`;
        if (flag === undefined || flag === 'inherited-marker') delete env[key];
        else Object.assign(env, { [key]: flag });
      }
      delete env['TEAMKB_TEST_LIVE_LANE'];
      if (flag === 'inherited-marker') env['TEAMKB_TEST_LIVE_LANE'] = '1';
      try {
        execFileSync(
          process.execPath,
          [
            '--import',
            join(repo, 'tests/support/live-collection-preload.mjs'),
            vitest,
            'run',
            ...files,
            '--maxWorkers=1',
            '--reporter=json',
            '--outputFile',
            report,
          ],
          { cwd: repo, env, timeout: 30_000, stdio: 'pipe' },
        );
        expect(readFileSync(log, 'utf8')).toBe('');
        const states = readFileSync(state, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const created = states.filter((entry) => entry.phase === 'created');
        expect(created).toHaveLength(3);
        for (const entry of created) {
          expect(existsSync(entry.root)).toBe(false);
        }
        const cleaned = states.filter((entry) => entry.phase === 'cleaned');
        expect(cleaned.length).toBeGreaterThan(0);
        for (const entry of cleaned) {
          expect(entry.environmentRestored).toBe(true);
          expect(entry.homeUnchanged).toBe(true);
        }
        const runs = states.filter((entry) => entry.phase === 'run-cleaned');
        expect(runs).toHaveLength(1);
        expect(existsSync(runs[0].root)).toBe(false);
        const result = JSON.parse(readFileSync(report, 'utf8'));
        expect(result.numPassedTests).toBe(2);
        expect(result.numPendingTests).toBe(5);
        expect(existsSync(join(scratch, 'brain/qmd-index/intent-solutions/cache'))).toBe(false);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    40_000,
  );

  it('proves every sentinel is active inside the Vitest worker using synthetic operations', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'teamkb-live-guard-'));
    const log = join(scratch, 'attempts.jsonl');
    writeFileSync(log, '');
    mkdirSync(join(scratch, 'bin'));
    writeFileSync(join(scratch, 'bin', 'qmd'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const config = join(scratch, 'vitest.config.mjs');
    writeFileSync(
      config,
      'export default { test: { include: ["tests/support/fixtures/sentinel-probes.fixture.ts"] } };',
    );
    const env = {
      ...process.env,
      TEAMKB_TEST_SENTINEL_LOG: log,
      TEAMKB_TEST_SYNTHETIC_ROOT: scratch,
      NODE_OPTIONS: '--import ' + join(repo, 'tests/support/live-collection-preload.mjs'),
    };
    try {
      execFileSync(process.execPath, [vitest, 'run', '--config', config, '--maxWorkers=1'], {
        cwd: repo,
        env,
        timeout: 30_000,
        stdio: 'pipe',
      });
      expect(
        readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).kind)
          .sort(),
      ).toEqual(['native-import', 'operator-path', 'qmd-execution', 'service-connection']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 40_000);

  it.each(['DENSE', 'RERANK', 'RETRIEVAL'])(
    'fails missing explicit %s configuration before access',
    (kind) => {
      const scratch = mkdtempSync(join(tmpdir(), 'teamkb-live-guard-'));
      const log = join(scratch, 'attempts.jsonl');
      writeFileSync(log, '');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TEAMKB_TEST_SENTINEL_LOG: log,
        NODE_OPTIONS: '--import ' + join(repo, 'tests/support/live-collection-preload.mjs'),
      };
      for (const key of Object.keys(env)) if (key.startsWith('TEAMKB_TEST_LIVE_')) delete env[key];
      env[`TEAMKB_TEST_LIVE_${kind}`] = '1';
      try {
        const result = spawnSync(
          process.execPath,
          [
            '--import',
            join(repo, 'tests/support/live-collection-preload.mjs'),
            vitest,
            'run',
            '--config',
            'vitest.live.config.ts',
            ...files,
            '--maxWorkers=1',
          ],
          { cwd: repo, env, timeout: 30_000, encoding: 'utf8' },
        );
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain(
          'Explicit live test configuration required',
        );
        expect(readFileSync(log, 'utf8')).toBe('');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    40_000,
  );

  it('runs explicitly configured retrieval on a disposable copy without modifying source indexes', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'teamkb-live-copy-entry-'));
    const source = join(scratch, 'source');
    const tenant = 'copy-entry-tenant';
    const exportDir = join(source, 'kb-export', 'curated');
    const sourceIndexDir = join(source, 'qmd-index', tenant);
    const index = join(sourceIndexDir, 'cache', 'qmd', 'index.sqlite');
    const registry = join(sourceIndexDir, 'config', 'qmd', 'index.yml');
    const native = join(sourceIndexDir, 'native-fts5.sqlite');
    const calls = join(scratch, 'calls.jsonl');
    const report = join(scratch, 'report.json');
    const binary = join(scratch, 'qmd');
    const id = '11111111-1111-4111-8111-111111111111';
    const file = join(exportDir, `${id}.md`);
    mkdirSync(exportDir, { recursive: true });
    mkdirSync(dirname(index), { recursive: true });
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(
      file,
      `---\nid: "${id}"\ntenant_id: "${tenant}"\n---\n\nSynthetic copied retrieval corpus.\n`,
    );
    writeFileSync(index, 'source index sentinel');
    writeFileSync(registry, `collections:\n  hostile:\n    path: ${source}\n`);
    writeFileSync(join(source, 'teamkb.db'), 'source database sentinel');
    const original = readFileSync(file);
    const sourceStat = lstatSync(file);
    writeFileSync(
      binary,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args,base:process.env.TEAMKB_BASE_PATH,
  index:process.env.INDEX_PATH,config:process.env.QMD_CONFIG_DIR,cwd:process.cwd()})+'\\n');
if (args[0] === '--version') process.stdout.write('qmd 2.5.3\\n');
if (args[0] === 'collection' && args[1] === 'add') {
  fs.mkdirSync(process.env.QMD_CONFIG_DIR,{recursive:true});
  fs.appendFileSync(path.join(process.env.QMD_CONFIG_DIR,'index.yml'),args[2]+'\\n');
}
if (args[0] === 'search') process.stdout.write(JSON.stringify([{file:'qmd://kb-curated/${id}.md',score:1,snippet:'synthetic'}]));
`,
      { mode: 0o700 },
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('TEAMKB_TEST_LIVE_')) delete env[key];
    Object.assign(env, {
      TEAMKB_TEST_LIVE_RETRIEVAL: '1',
      TEAMKB_TEST_LIVE_BASE_PATH: source,
      TEAMKB_TEST_LIVE_TENANT_ID: tenant,
      TEAMKB_TEST_LIVE_QMD_BIN: binary,
      TEAMKB_BASE_PATH: source,
      INDEX_PATH: index,
      QMD_CONFIG_DIR: dirname(registry),
    });
    delete env['NODE_OPTIONS'];
    try {
      execFileSync(
        process.execPath,
        [
          vitest,
          'run',
          '--config',
          'vitest.live.config.ts',
          files[2]!,
          '--maxWorkers=1',
          '--reporter=json',
          '--outputFile',
          report,
        ],
        {
          cwd: repo,
          env,
          timeout: 60_000,
          stdio: 'pipe',
        },
      );
      const result = JSON.parse(readFileSync(report, 'utf8'));
      expect(result.numPassedTests).toBe(3);
      expect(result.numPendingTests).toBe(0);
      expect(existsSync(native)).toBe(false);
      expect(readFileSync(index, 'utf8')).toBe('source index sentinel');
      expect(readFileSync(registry, 'utf8')).toBe(
        `collections:\n  hostile:\n    path: ${source}\n`,
      );
      expect(readFileSync(join(source, 'teamkb.db'), 'utf8')).toBe('source database sentinel');
      expect(readFileSync(file)).toEqual(original);
      expect(lstatSync(file).ino).toBe(sourceStat.ino);
      expect(lstatSync(file).mtimeMs).toBe(sourceStat.mtimeMs);
      const observed = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              args: string[];
              base: string;
              index: string;
              config: string;
              cwd: string;
            },
        );
      expect(observed.length).toBeGreaterThan(0);
      for (const call of observed) {
        expect(call.base).not.toBe(source);
        expect(call.base).toBe(join(call.cwd, 'brain'));
        expect(call.index.startsWith(call.base + '/')).toBe(true);
        expect(call.config.startsWith(call.base + '/')).toBe(true);
        expect(call.args).toContain('--index');
        expect(existsSync(call.cwd)).toBe(false);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 70_000);
});
