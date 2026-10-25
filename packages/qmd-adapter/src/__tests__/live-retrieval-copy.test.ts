import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import type * as FsModule from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRetrievalCopy,
  runCopiedRetrieval,
  type CopiedRetrievalResult,
} from './live-retrieval-copy.js';

const io = vi.hoisted(() => ({
  copyRoots: [] as string[],
  reads: 0,
  failRead: 0,
  replacementWorker: undefined as string | undefined,
  syntheticChild: undefined as unknown,
  hideSelfWitness: false,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (io.syntheticChild !== undefined) return io.syntheticChild;
      if (io.replacementWorker !== undefined)
        return actual.spawn(args[0], [io.replacementWorker], args[2]);
      return actual.spawn(...args);
    },
  };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof FsModule>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (io.hideSelfWitness && args[0] === `/proc/${process.pid}/stat`)
        throw new Error('Synthetic proc unavailable');
      return actual.readFileSync(...args);
    },
    mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => {
      const root = actual.mkdtempSync(...args);
      if (String(args[0]).includes('teamkb-retrieval-copy-')) io.copyRoots.push(String(root));
      return root;
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      io.reads++;
      if (io.reads === io.failRead) throw new Error('Injected copy read failure');
      return actual.readSync(...args);
    },
  };
});
const DOC = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONTENT = `---\nid: "${DOC}"\ntenant_id: "copy-tenant"\ntitle: "Synthetic copy"\n---\n\nSynthetic copied export body.\n`;

describe('disposable copied retrieval boundary', () => {
  let root: string;
  let source: string;
  let file: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'retrieval-copy-fixture-'));
    source = join(root, 'source');
    mkdirSync(join(source, 'kb-export', 'curated'), { recursive: true });
    file = join(source, 'kb-export', 'curated', `${DOC}.md`);
    writeFileSync(file, CONTENT, { mode: 0o600 });
    io.copyRoots = [];
    io.reads = 0;
    io.failRead = 0;
    io.replacementWorker = undefined;
    io.syntheticChild = undefined;
    io.hideSelfWitness = false;
  });
  afterEach(() => {
    vi.useRealTimers();
    io.replacementWorker = undefined;
    io.syntheticChild = undefined;
    io.hideSelfWitness = false;
    io.failRead = 0;
    // These are exact roots captured at this fixture's own mkdtemp calls.
    for (const owned of io.copyRoots) rmSync(owned, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('copies independent regular export bytes and ignores source indexes, registry and secrets', () => {
    mkdirSync(join(source, 'qmd-index', 'copy-tenant'), { recursive: true });
    writeFileSync(
      join(source, 'qmd-index', 'copy-tenant', 'index.sqlite-wal'),
      'source WAL sentinel',
    );
    writeFileSync(join(source, 'teamkb.db'), 'source DB sentinel');
    writeFileSync(join(source, 'secret'), 'source secret sentinel');
    linkSync(file, join(root, 'original-hardlink.md'));
    const before = lstatSync(file);
    const copy = createRetrievalCopy(source);
    const target = join(copy.exportDir, 'curated', `${DOC}.md`);
    expect(readFileSync(target, 'utf8')).toBe(CONTENT);
    expect(lstatSync(target).ino).not.toBe(before.ino);
    expect(lstatSync(target).nlink).toBe(1);
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    expect(lstatSync(copy.root).mode & 0o777).toBe(0o700);
    expect(copy.copiedFiles).toBe(1);
    expect(copy.copiedBytes).toBe(Buffer.byteLength(CONTENT));
    expect(readdirSync(copy.basePath)).toEqual(['kb-export']);
    expect(lstatSync(file).ino).toBe(before.ino);
    expect(lstatSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(file, 'utf8')).toBe(CONTENT);
    copy.cleanup();
    expect(existsSync(copy.root)).toBe(false);
    expect(readFileSync(join(source, 'teamkb.db'), 'utf8')).toBe('source DB sentinel');
  });

  it('rejects relative, missing and aliased source ancestors without creating a copy', () => {
    expect(() => createRetrievalCopy('relative')).toThrow('absolute');
    expect(() => createRetrievalCopy(join(root, 'missing'))).toThrow();
    symlinkSync(source, join(root, 'alias'), 'dir');
    expect(() => createRetrievalCopy(join(root, 'alias'))).toThrow('regular directories');
    expect(io.copyRoots).toEqual([]);
  });

  it.each(['leaf', 'collection'])(
    'refuses an outside %s symlink without changing its sentinel',
    (kind) => {
      const outside = join(root, 'outside');
      if (kind === 'leaf') {
        writeFileSync(outside, CONTENT);
        symlinkSync(outside, join(source, 'kb-export', 'curated', 'z.md'));
      } else {
        mkdirSync(outside);
        writeFileSync(join(outside, 'outside.md'), CONTENT);
        symlinkSync(outside, join(source, 'kb-export', 'decisions'));
      }
      expect(() => createRetrievalCopy(source)).toThrow('Unsupported export');
      expect(io.copyRoots.length).toBeGreaterThan(0);
      expect(io.copyRoots.every((owned) => !existsSync(owned))).toBe(true);
      expect(readFileSync(kind === 'leaf' ? outside : join(outside, 'outside.md'), 'utf8')).toBe(
        CONTENT,
      );
    },
  );

  it('rejects a FIFO without opening or waiting on it', () => {
    execFileSync('/usr/bin/mkfifo', [join(source, 'kb-export', 'curated', 'z.md')], {
      timeout: 1_000,
    });
    expect(() => createRetrievalCopy(source)).toThrow('Unsupported export entry');
    expect(io.copyRoots.every((owned) => !existsSync(owned))).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(CONTENT);
  });

  it('removes only its own partial copy after an interrupted multi-chunk file read', () => {
    const original = Buffer.alloc(300 * 1024, 65);
    writeFileSync(file, original);
    const before = lstatSync(file);
    io.failRead = 2;
    expect(() => createRetrievalCopy(source)).toThrow('Injected copy read failure');
    expect(io.reads).toBe(2);
    expect(io.copyRoots.every((owned) => !existsSync(owned))).toBe(true);
    expect(readFileSync(file)).toEqual(original);
    expect(lstatSync(file).ino).toBe(before.ino);
    expect(lstatSync(file).mtimeMs).toBe(before.mtimeMs);
  });

  it('refuses empty exports and invalid configuration before any binary invocation', async () => {
    const marker = join(root, 'should-not-run');
    const binary = join(root, 'qmd');
    writeFileSync(
      binary,
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`,
      { mode: 0o700 },
    );
    const options = { sourceBase: source, tenantId: 'copy-tenant', qmdBinary: binary };
    await expect(runCopiedRetrieval({ ...options, tenantId: '../escape' })).rejects.toThrow(
      'Explicit tenant',
    );
    await expect(runCopiedRetrieval({ ...options, qmdBinary: 'relative' })).rejects.toThrow(
      'absolute',
    );
    await expect(runCopiedRetrieval({ ...options, timeoutMs: 120_001 })).rejects.toThrow('timeout');
    rmSync(file);
    await expect(runCopiedRetrieval(options)).rejects.toThrow('no exported content');
    expect(existsSync(marker)).toBe(false);
    expect(io.copyRoots.every((owned) => !existsSync(owned))).toBe(true);
  });

  it('retains owned scratch after a worker failure rather than deleting under a possible writer', async () => {
    const binary = join(root, 'qmd-refused');
    writeFileSync(binary, `#!${process.execPath}\nprocess.exit(23);\n`, { mode: 0o700 });
    await expect(
      runCopiedRetrieval({
        sourceBase: source,
        tenantId: 'copy-tenant',
        qmdBinary: binary,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow('scratch retained');
    expect(io.copyRoots).toHaveLength(1);
    expect(existsSync(io.copyRoots[0]!)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(CONTENT);
    // This fixture executable cannot spawn descendants; the worker was awaited.
    // afterEach owns only the roots captured from this fixture's mkdtemp calls.
  }, 20_000);

  it.each([
    'not-json',
    JSON.stringify({ report: { queryCount: 1 }, stratified: {}, groupsClosed: false }),
  ])(
    'retains scratch for a code-zero invalid worker report (%s)',
    async (response) => {
      const replacement = join(root, 'invalid-report.cjs');
      writeFileSync(
        replacement,
        `process.stdin.resume(); process.stdout.write(${JSON.stringify(response)});`,
      );
      io.replacementWorker = replacement;
      await expect(
        runCopiedRetrieval({
          sourceBase: source,
          tenantId: 'copy-tenant',
          qmdBinary: process.execPath,
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow('scratch retained');
      expect(io.copyRoots).toHaveLength(1);
      expect(existsSync(io.copyRoots[0]!)).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(CONTENT);
    },
    20_000,
  );

  it('retains an envelope-valid report when parent semantic validation fails', async () => {
    const replacement = join(root, 'semantic-invalid-report.cjs');
    const response = { report: { queryCount: 1 }, stratified: {}, groupsClosed: true };
    writeFileSync(
      replacement,
      `process.stdin.resume(); process.stdout.write(${JSON.stringify(JSON.stringify(response))});`,
    );
    io.replacementWorker = replacement;
    const semanticError = new Error('Fixture semantic report refusal');
    const validateResult = vi.fn((result: CopiedRetrievalResult) => {
      expect(result.copiedFiles).toBe(1);
      expect(result.copiedBytes).toBe(Buffer.byteLength(CONTENT));
      expect(io.copyRoots).toHaveLength(1);
      expect(existsSync(io.copyRoots[0]!)).toBe(true);
      expect(result.report.queryCount).toBe(1);
      expect(result.stratified).toEqual({});
      throw semanticError;
    });
    const failure: unknown = await runCopiedRetrieval({
      sourceBase: source,
      tenantId: 'copy-tenant',
      qmdBinary: process.execPath,
      timeoutMs: 10_000,
      validateResult,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      `Copied retrieval worker failed; scratch retained at ${io.copyRoots[0]}`,
    );
    expect(validateResult).toHaveBeenCalledTimes(1);
    expect(validateResult.mock.results[0]).toMatchObject({ type: 'throw', value: semanticError });
    expect(io.copyRoots).toHaveLength(1);
    expect(existsSync(io.copyRoots[0]!)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(CONTENT);
  }, 20_000);

  it('refuses missing self proc witnesses before making a copy', async () => {
    io.hideSelfWitness = true;
    await expect(
      runCopiedRetrieval({
        sourceBase: source,
        tenantId: 'copy-tenant',
        qmdBinary: process.execPath,
      }),
    ).rejects.toThrow('readable proc PID witnesses');
    expect(io.copyRoots).toEqual([]);
  });

  it('bounds rejection without close or a child PID witness, without signaling or deleting', async () => {
    const kill = vi.fn();
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill,
      unref,
    });
    io.syntheticChild = child;
    vi.useFakeTimers();
    const pending = runCopiedRetrieval({
      sourceBase: source,
      tenantId: 'copy-tenant',
      qmdBinary: process.execPath,
    });
    const refused = expect(pending).rejects.toThrow('scratch retained');
    await vi.advanceTimersByTimeAsync(8_001);
    await refused;
    expect(kill).not.toHaveBeenCalled();
    expect(unref).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(io.copyRoots).toHaveLength(1);
    expect(existsSync(io.copyRoots[0]!)).toBe(true);
    // Pure stream/clock control: no OS process was created by the mocked spawn.
  });

  it('runs the actual worker with a fake qmd using only copied registry/base paths', async () => {
    const log = join(root, 'qmd-calls.jsonl');
    const binary = join(root, 'qmd');
    mkdirSync(join(source, 'qmd-index', 'copy-tenant', 'config', 'qmd'), { recursive: true });
    const sourceRegistry = join(source, 'qmd-index', 'copy-tenant', 'config', 'qmd', 'index.yml');
    writeFileSync(sourceRegistry, `collections:\n  hostile:\n    path: ${source}\n`);
    writeFileSync(join(source, 'teamkb.db'), 'database sentinel');
    const before = lstatSync(file);
    vi.stubEnv('TEAMKB_QMD_BIN', '/hostile/ambient/qmd');
    vi.stubEnv('TEAMKB_BASE_PATH', source);
    vi.stubEnv('QMD_CONFIG_DIR', dirnameForPoison());
    vi.stubEnv('TEAMKB_API_TOKEN', 'synthetic-must-not-inherit');
    writeFileSync(
      binary,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, cwd:process.cwd(),
  base:process.env.TEAMKB_BASE_PATH, home:process.env.HOME,
  index:process.env.INDEX_PATH, config:process.env.QMD_CONFIG_DIR,
  token:process.env.TEAMKB_API_TOKEN, pin:process.env.TEAMKB_QMD_BIN})+'\\n');
if (args[0] === '--version') process.stdout.write('qmd 2.5.3\\n');
if (args[0] === 'collection' && args[1] === 'add') {
  fs.mkdirSync(process.env.QMD_CONFIG_DIR,{recursive:true});
  fs.appendFileSync(path.join(process.env.QMD_CONFIG_DIR,'index.yml'),args[2]+'\\n');
}
if (args[0] === 'search') process.stdout.write(JSON.stringify([{file:'qmd://kb-curated/${DOC}.md',score:1,snippet:'synthetic'}]));
`,
      { mode: 0o700 },
    );
    const validateResult = vi.fn((result: CopiedRetrievalResult) => {
      expect(result.report.queryCount).toBeGreaterThan(0);
      expect(result.copiedFiles).toBe(1);
      expect(io.copyRoots).toHaveLength(1);
      expect(existsSync(io.copyRoots[0]!)).toBe(true);
    });
    const result = await runCopiedRetrieval({
      sourceBase: source,
      tenantId: 'copy-tenant',
      qmdBinary: binary,
      validateResult,
    });
    expect(validateResult).toHaveBeenCalledTimes(1);
    expect(result.report.queryCount).toBeGreaterThan(0);
    expect(result.stratified.overall.queryCount).toBe(result.report.queryCount);
    expect(
      result.report.perQuery.some((query) =>
        query.retrieved.includes(`qmd://kb-curated/${DOC}.md`),
      ),
    ).toBe(true);
    expect(result.copiedFiles).toBe(1);
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            cwd: string;
            base: string;
            home: string;
            index: string;
            config: string;
            token?: string;
            pin?: string;
          },
      );
    expect(calls[0]!.args[0]).toBe('--version');
    for (const call of calls) {
      expect(call.cwd).not.toBe(source);
      expect(call.base).toBe(join(call.cwd, 'brain'));
      expect(call.home).toBe(join(call.cwd, 'home'));
      expect(call.index.startsWith(call.base + '/')).toBe(true);
      expect(call.config.startsWith(call.base + '/')).toBe(true);
      expect(call.token).toBeUndefined();
      expect(call.pin).toBeUndefined();
      expect(call.args).toContain('--index');
      if (call.args.includes('--'))
        expect(call.args.indexOf('--index')).toBeLessThan(call.args.indexOf('--'));
      if (call.args[0] === 'collection' && call.args[1] === 'add')
        expect(call.args[2]!.startsWith(call.base + '/kb-export/')).toBe(true);
    }
    expect(
      calls.filter((call) => call.args[0] === 'collection' && call.args[1] === 'add'),
    ).toHaveLength(5);
    expect(io.copyRoots).toHaveLength(1);
    expect(existsSync(io.copyRoots[0]!)).toBe(false);
    expect(lstatSync(file).ino).toBe(before.ino);
    expect(lstatSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(file, 'utf8')).toBe(CONTENT);
    expect(readFileSync(sourceRegistry, 'utf8')).toContain(`path: ${source}`);
    expect(readFileSync(join(source, 'teamkb.db'), 'utf8')).toBe('database sentinel');
  }, 140_000);

  function dirnameForPoison(): string {
    const poison = join(root, '.qmd');
    mkdirSync(poison);
    writeFileSync(join(poison, 'index.yaml'), `path: ${source}\n`);
    return poison;
  }
});
