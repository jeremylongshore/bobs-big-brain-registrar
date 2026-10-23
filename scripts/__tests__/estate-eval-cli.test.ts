import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, MemoryRepository } from '../../packages/store/src/index.js';
import { makeMemory } from '../../packages/test-fixtures/src/index.js';
import { NativeIndexManager } from '../../packages/qmd-adapter/src/native/native-index-manager.js';
import { DenseVecIndex } from '../../packages/qmd-adapter/src/dense/dense-index.js';
import { formatMemoryAsMarkdown } from '../../apps/git-exporter/src/formatter/markdown-formatter.js';

const root = resolve('.');
const qmd = join(root, 'node_modules', '.bin', 'qmd');
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const launcher = join(root, 'scripts', 'eval-estate-onboarding.ts');

function dataFiles(base: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.endsWith('-shm'))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => !path.endsWith('-wal') || readFileSync(path).length > 0)
      .map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
  );
}

describe('estate evaluation isolated CLI', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'estate-cli-test-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it(
    'refreshes native retrieval in the worker without modifying source indexes or following inherited qmd paths',
    { timeout: 30_000 },
    () => {
      const tenant = 'fixture';
      const exportDir = join(base, 'kb-export');
      const index = join(base, 'qmd-index', tenant);
      const memory = makeMemory({
        tenantId: tenant,
        category: 'reference',
        content: 'isolationcanary current answer',
        title: 'Fixture current answer',
      });
      const db = createDatabase({ path: join(base, 'teamkb.db') });
      new MemoryRepository(db).insert(memory);
      db.close();
      const file = join(exportDir, 'guides', `${memory.id}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        formatMemoryAsMarkdown({ ...memory, content: 'oldkeyword prior answer' }),
      );
      utimesSync(file, 1_000_000, 1_000_000);
      const native = new NativeIndexManager({
        exportDir,
        indexPath: join(index, 'native-fts5.sqlite'),
      });
      native.ensureFresh();
      native.close();
      const env = {
        ...process.env,
        INDEX_PATH: join(index, 'cache', 'qmd', 'index.sqlite'),
        QMD_CONFIG_DIR: join(index, 'config', 'qmd'),
      };
      mkdirSync(dirname(env.INDEX_PATH), { recursive: true });
      execFileSync(
        qmd,
        ['--index', 'index', 'collection', 'add', join(exportDir, 'guides'), '--name', 'kb-guides'],
        { env, cwd: base, stdio: 'ignore' },
      );
      execFileSync(qmd, ['--index', 'index', 'update'], { env, cwd: base, stdio: 'ignore' });
      const dense = new DenseVecIndex({
        path: join(index, 'dense-vec.sqlite'),
        modelId: 'old-model',
        modelVersion: 'old-version',
      });
      dense.upsert({
        docId: `qmd://kb-guides/${memory.id}.md`,
        collection: 'kb-guides',
        contentHash: 'h',
        snippet: 'prior',
        embedding: new Float32Array([1, 0, 0]),
      });
      dense.close();
      // This changed export forces a refresh in the copied native index. The
      // stale qmd and source native indexes have never indexed this keyword.
      writeFileSync(file, formatMemoryAsMarkdown(memory));
      utimesSync(file, 2_000_000, 2_000_000);
      const scratch = join(base, 'scratch');
      mkdirSync(scratch);
      mkdirSync(join(base, '.qmd'));
      writeFileSync(
        join(base, '.qmd', 'index.yml'),
        'invalid: [project-discovery-must-not-use-this',
      );
      const unwantedIndex = join(base, 'do-not-open.sqlite');
      writeFileSync(unwantedIndex, 'sentinel');
      const before = dataFiles(base);
      const output = execFileSync(
        process.execPath,
        ['--import', tsx, launcher, '--probe', 'isolationcanary'],
        {
          cwd: base,
          encoding: 'utf8',
          env: {
            ...env,
            TSX_DISABLE_CACHE: '1',
            TEAMKB_BASE_PATH: base,
            TEAMKB_TENANT: tenant,
            TEAMKB_DENSE_ENABLED: 'true',
            TEAMKB_QMD_BIN: qmd,
            TMPDIR: scratch,
            INDEX_PATH: unwantedIndex,
            QMD_CONFIG_DIR: join(base, '.qmd'),
          },
        },
      );
      expect(output).toContain(`qmd://kb-guides/${memory.id}.md`);
      expect(output).toContain('DEGRADED: dense arm failed');
      expect(output).toContain('unbuilt-or-empty:1');
      expect(output).toContain('not an atomic corpus snapshot');
      expect(dataFiles(base)).toEqual(before);
      expect(readdirSync(scratch)).toEqual([]);
    },
  );

  it(
    'propagates an unavailable qmd worker exit and removes temporary snapshots',
    { timeout: 15_000 },
    () => {
      createDatabase({ path: join(base, 'teamkb.db') }).close();
      const scratch = join(base, 'scratch');
      mkdirSync(scratch);
      let status: number | null = null;
      try {
        execFileSync(process.execPath, ['--import', tsx, launcher, '--probe', 'anything'], {
          cwd: base,
          env: {
            ...process.env,
            TSX_DISABLE_CACHE: '1',
            TEAMKB_BASE_PATH: base,
            TEAMKB_TENANT: 'fixture',
            TEAMKB_QMD_BIN: join(base, 'absent-qmd'),
            TMPDIR: scratch,
          },
          stdio: 'ignore',
        });
      } catch (error) {
        status = (error as { status: number | null }).status;
      }
      expect(status).toBe(2);
      expect(readdirSync(scratch)).toEqual([]);
    },
  );
  it(
    'interrupts an active worker and removes its temporary databases',
    { timeout: 30_000 },
    async () => {
      createDatabase({ path: join(base, 'teamkb.db') }).close();
      const scratch = join(base, 'scratch');
      mkdirSync(scratch);
      const started = join(base, 'started');
      const binary = join(base, 'slow-qmd');
      writeFileSync(
        binary,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(started)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
        { mode: 0o700 },
      );
      const child = spawn(process.execPath, ['--import', tsx, launcher, '--probe', 'fixture'], {
        cwd: base,
        stdio: 'ignore',
        env: {
          ...process.env,
          TSX_DISABLE_CACHE: '1',
          TEAMKB_BASE_PATH: base,
          TEAMKB_TENANT: 'fixture',
          TEAMKB_QMD_BIN: binary,
          TMPDIR: scratch,
        },
      });
      const done = new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', resolveExit);
      });
      try {
        const deadline = Date.now() + 20_000;
        while (!existsSync(started) && Date.now() < deadline)
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        expect(existsSync(started)).toBe(true);
        const qmdPid = Number(readFileSync(started, 'utf8'));
        child.kill('SIGTERM');
        expect(await done).toBe(143);
        expect(() => process.kill(qmdPid, 0)).toThrow();
        expect(readdirSync(scratch)).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await done;
      }
    },
  );
});
