import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { QmdAdapter } from '../adapter.js';
import { RealQmdExecutor } from '../executor/real-executor.js';
import {
  QMD_BIN_ENV,
  QMD_NOT_FOUND_EXIT_CODE,
  QmdBinaryNotFoundError,
  resolveQmdBinary,
} from '../executor/resolve-binary.js';

/** Pure resolution: injected probe, no real filesystem. */
describe('resolveQmdBinary (injected probe)', () => {
  const only =
    (...present: string[]) =>
    (p: string): boolean =>
      present.includes(p);

  it('prefers the explicit config path over env, PATH and ~/.bun/bin', () => {
    const r = resolveQmdBinary({
      explicit: '/opt/qmd',
      env: { [QMD_BIN_ENV]: '/env/qmd', PATH: '/usr/bin' },
      home: '/h',
      isExecutable: only('/opt/qmd', '/env/qmd', '/usr/bin/qmd', '/h/.bun/bin/qmd'),
    });
    expect(r).toEqual({ path: '/opt/qmd', source: 'explicit' });
  });

  it('uses TEAMKB_QMD_BIN next', () => {
    const r = resolveQmdBinary({
      env: { [QMD_BIN_ENV]: '/env/qmd', PATH: '/usr/bin' },
      home: '/h',
      isExecutable: only('/env/qmd', '/usr/bin/qmd'),
    });
    expect(r).toEqual({ path: '/env/qmd', source: 'env' });
  });

  it('then qmd on PATH (first PATH entry wins; empty entries skipped)', () => {
    const r = resolveQmdBinary({
      env: { PATH: `::/a:/b` },
      home: '/h',
      isExecutable: only('/a/qmd', '/b/qmd', '/h/.bun/bin/qmd'),
    });
    expect(r).toEqual({ path: '/a/qmd', source: 'path' });
  });

  it('then ~/.bun/bin/qmd when PATH lacks it (the MCP-environment case)', () => {
    const r = resolveQmdBinary({
      env: { PATH: '/usr/bin' },
      home: '/home/x',
      isExecutable: only('/home/x/.bun/bin/qmd'),
    });
    expect(r).toEqual({ path: '/home/x/.bun/bin/qmd', source: 'bun-default' });
  });

  it('a bare command name in TEAMKB_QMD_BIN is looked up on PATH', () => {
    const r = resolveQmdBinary({
      env: { [QMD_BIN_ENV]: 'qmd-nightly', PATH: '/p' },
      isExecutable: only('/p/qmd-nightly'),
    });
    expect(r).toEqual({ path: '/p/qmd-nightly', source: 'env' });
  });

  it('throws an actionable error naming everything searched and the fix', () => {
    let err: unknown;
    try {
      resolveQmdBinary({ env: { PATH: '/usr/bin' }, home: '/home/x', isExecutable: () => false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QmdBinaryNotFoundError);
    const e = err as QmdBinaryNotFoundError;
    expect(e.message).toMatch(/qmd binary not found/);
    expect(e.message).toContain('/home/x/.bun/bin/qmd');
    expect(e.message).toContain('PATH');
    expect(e.message).toContain(QMD_BIN_ENV);
    expect(e.searched).toEqual(['PATH', '/home/x/.bun/bin/qmd']);
  });

  it.each([
    ['explicit', { explicit: '/nope/qmd', env: { PATH: '/usr/bin' } }, /qmdBinary/],
    ['env', { env: { [QMD_BIN_ENV]: '/nope/qmd', PATH: '/usr/bin' } }, new RegExp(QMD_BIN_ENV)],
  ])('a broken %s pin is an error, never silently replaced by another qmd', (_n, opts, re) => {
    expect(() =>
      resolveQmdBinary({
        ...opts,
        isExecutable: (p) => p === '/usr/bin/qmd' || p.endsWith('/.bun/bin/qmd'),
      }),
    ).toThrow(re);
  });

  it('a pinned bare name not on PATH is an error', () => {
    expect(() =>
      resolveQmdBinary({ explicit: 'qmd-x', env: { PATH: '/p' }, isExecutable: () => false }),
    ).toThrow(/no executable by that name is on PATH/);
  });

  it('blank pins are ignored', () => {
    const r = resolveQmdBinary({
      explicit: '  ',
      env: { [QMD_BIN_ENV]: '', PATH: '/p' },
      isExecutable: only('/p/qmd'),
    });
    expect(r.source).toBe('path');
  });
});

/** Real filesystem: a throwaway fake qmd in a temp dir. */
describe('resolveQmdBinary + RealQmdExecutor (real fs, fake qmd)', () => {
  let dir: string;
  let fake: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qmd-resolve-'));
    mkdirSync(join(dir, '.bun', 'bin'), { recursive: true });
    fake = join(dir, '.bun', 'bin', 'qmd');
    // Echoes the PATH it was given first, so the test can see the bin dir was prepended.
    writeFileSync(fake, '#!/bin/sh\necho "args:$*"\necho "path:$PATH"\n');
    chmodSync(fake, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds ~/.bun/bin/qmd via the real fs probe', () => {
    expect(resolveQmdBinary({ env: { PATH: '/nonexistent' }, home: dir })).toEqual({
      path: fake,
      source: 'bun-default',
    });
  });

  it('rejects a non-executable file and a directory', () => {
    const plain = join(dir, 'plain');
    writeFileSync(plain, 'x');
    chmodSync(plain, 0o644);
    expect(() => resolveQmdBinary({ explicit: plain })).toThrow(QmdBinaryNotFoundError);
    expect(() => resolveQmdBinary({ explicit: dir })).toThrow(QmdBinaryNotFoundError);
  });

  it('executor runs a pinned binary and prepends its directory to the child PATH', async () => {
    const exec = new RealQmdExecutor({ binary: fake });
    const r = await exec.execute(['update']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('args:update');
    expect(r.stdout).toContain(`path:${join(dir, '.bun', 'bin')}:`);
  });

  describe('with nothing resolvable', () => {
    let savedPath: string | undefined;
    let savedBin: string | undefined;
    let savedHome: string | undefined;
    beforeEach(() => {
      savedPath = process.env['PATH'];
      savedBin = process.env[QMD_BIN_ENV];
      savedHome = process.env['HOME'];
      process.env['PATH'] = '/nonexistent-bin-dir';
      delete process.env[QMD_BIN_ENV];
      process.env['HOME'] = join(dir, 'empty-home');
    });
    afterEach(() => {
      process.env['PATH'] = savedPath;
      if (savedBin !== undefined) process.env[QMD_BIN_ENV] = savedBin;
      process.env['HOME'] = savedHome;
    });

    it('executor returns exit 127 with the actionable message instead of throwing', async () => {
      const r = await new RealQmdExecutor().execute(['update']);
      expect(r.exitCode).toBe(QMD_NOT_FOUND_EXIT_CODE);
      expect(r.stderr).toMatch(/qmd binary not found/);
      expect(r.stderr).toContain(QMD_BIN_ENV);
    });

    it('isAvailable() is false and a later install is picked up (failure is not cached)', async () => {
      const exec = new RealQmdExecutor();
      expect(await exec.isAvailable()).toBe(false);
      process.env[QMD_BIN_ENV] = fake;
      expect((await exec.execute(['--version'])).exitCode).toBe(0);
      expect(await exec.isAvailable()).toBe(true);
    });

    it('adapter.update()/ensureCollections() report not_available with the real reason', async () => {
      const exportDir = join(dir, 'kb-export');
      const adapter = new QmdAdapter({
        tenantId: 'resolve-test',
        exportDir,
        disableNativeFusion: true,
      });
      const ensure = await adapter.ensureCollections();
      expect(ensure.ok).toBe(false);
      if (!ensure.ok) {
        expect(ensure.error.code).toBe('not_available');
        expect(ensure.error.message).toMatch(/qmd binary not found/);
      }
      const upd = await adapter.update();
      expect(upd.ok).toBe(false);
      if (!upd.ok) {
        expect(upd.error.code).toBe('not_available');
        expect(upd.error.message).toMatch(/TEAMKB_QMD_BIN/);
      }
    });
  });
});
