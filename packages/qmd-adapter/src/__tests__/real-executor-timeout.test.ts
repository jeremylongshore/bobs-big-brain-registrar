/**
 * Process-group ownership for qmd runs (bead compile-then-govern-39z.20).
 *
 * The real qmd binary is a launcher that spawns `node dist/cli/qmd.js` and does
 * NOT forward SIGTERM. The fake binaries here reproduce that shape with a
 * shell parent that backgrounds a grandchild and waits on it: signalling only
 * the parent (what `execFile({ timeout })` did) orphans the grandchild, which
 * is exactly how a timed-out `qmd update` kept writing the index after the
 * wrapper reported failure. Every test asserts the grandchild PID is gone.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RealQmdExecutor,
  QMD_TIMEOUT_EXIT_CODE,
  isMaintenanceCommand,
} from '../executor/real-executor.js';
import { liveGroupCount } from '../executor/process-groups.js';
import { describeQmdFailure } from '../executor/describe-failure.js';
import { DEFAULT_MAINTENANCE_TIMEOUT, DEFAULT_TIMEOUT, QMD_TIMEOUT_ENV } from '../config.js';
import { IndexLifecycleManager } from '../index-manager/index-lifecycle.js';

const POSIX = process.platform !== 'win32';
const HERE = dirname(fileURLToPath(import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Orphans are reaped by init asynchronously — give it a moment. */
async function waitGone(pid: number, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

async function waitForFile(path: string, ms = 5_000): Promise<string> {
  const end = Date.now() + ms;
  while (!existsSync(path) || readFileSync(path, 'utf8').trim() === '') {
    if (Date.now() > end) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  return readFileSync(path, 'utf8').trim();
}

describe.skipIf(!POSIX)('RealQmdExecutor process-group ownership', () => {
  let dir: string;
  let pidFile: string;

  const script = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qmd-exec-timeout-'));
    pidFile = join(dir, 'grandchild.pid');
  });
  afterEach(() => {
    // Belt and braces: never leak a sleeper even if an assertion failed.
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('a timeout terminates the launcher AND its grandchild before resolving', async () => {
    // Launcher-shaped fake: backgrounds the real worker and waits on it.
    const fake = script('slow-qmd', `sleep 300 &\necho $! > "${pidFile}"\nwait`);
    const exec = new RealQmdExecutor({ binary: fake, maintenanceTimeout: 400, killGraceMs: 2_000 });

    const started = Date.now();
    const r = await exec.execute(['update']);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());

    expect(r.exitCode).toBe(QMD_TIMEOUT_EXIT_CODE);
    expect(r.failure).toMatchObject({ kind: 'timeout', timeoutMs: 400, groupTerminated: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    // The orphan that kept writing the index in the 2026-10-08 incident.
    expect(await waitGone(grandchild)).toBe(true);
    expect(liveGroupCount()).toBe(0);
  }, 15_000);

  it('escalates to SIGKILL when the group ignores SIGTERM', async () => {
    const fake = script(
      'stubborn-qmd',
      `sh -c 'trap "" TERM; echo $$ > "${pidFile}"; while :; do sleep 1; done' &\nwait`,
    );
    const exec = new RealQmdExecutor({ binary: fake, maintenanceTimeout: 300, killGraceMs: 300 });

    const r = await exec.execute(['update']);
    const grandchild = Number(await waitForFile(pidFile));

    expect(r.failure).toMatchObject({ kind: 'timeout', groupTerminated: true });
    expect(await waitGone(grandchild)).toBe(true);
  }, 15_000);

  it('reports the timeout with elapsed time, the limit and how to raise it', async () => {
    const fake = script('slow-qmd', `sleep 300 &\necho $! > "${pidFile}"\nwait`);
    const lifecycle = new IndexLifecycleManager(
      new RealQmdExecutor({ binary: fake, maintenanceTimeout: 250, killGraceMs: 1_000 }),
    );

    const r = await lifecycle.update();

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('timeout');
      expect(r.error.message).toMatch(/^qmd update timed out after \d+\.\ds \(limit 250 ms\)/);
      expect(r.error.message).toContain('no qmd process is still writing the index');
      expect(r.error.message).toContain(QMD_TIMEOUT_ENV);
      expect(r.error.message).toContain('--timeout-ms');
      expect(r.error.message).not.toContain('Failed to update index');
    }
  }, 15_000);

  it('a non-zero exit reports the exit code and a bounded stderr tail, not a timeout', async () => {
    const noisy = Array.from({ length: 50 }, (_v, i) => `echo "line ${i}" >&2`).join('\n');
    const fake = script(
      'failing-qmd',
      `${noisy}\necho "SQLITE_BUSY: database is locked" >&2\nexit 3`,
    );
    const lifecycle = new IndexLifecycleManager(new RealQmdExecutor({ binary: fake }));

    const r = await lifecycle.update();

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('command_failed');
      expect(r.error.message).toMatch(/^qmd update exited with code 3; stderr: /);
      expect(r.error.message).toContain('SQLITE_BUSY: database is locked');
      expect(r.error.message).not.toContain('line 0\n'); // older lines dropped
      expect(r.error.message.split('\n').length).toBeLessThanOrEqual(20);
    }
  });

  it('a qmd killed by a signal is reported as such', async () => {
    const fake = script('killed-qmd', 'echo dying >&2\nkill -KILL $$');
    const r = await new RealQmdExecutor({ binary: fake }).execute(['update']);
    expect(r.exitCode).toBe(137);
    expect(r.failure).toMatchObject({ kind: 'signal', signal: 'SIGKILL' });
    expect(describeQmdFailure(['update'], r).message).toMatch(
      /^qmd update was killed by SIGKILL after \d+\.\ds; stderr: dying$/,
    );
  });

  it('output beyond the cap terminates the group and is reported', async () => {
    const fake = script('chatty-qmd', 'head -c 11000000 /dev/zero\nsleep 300');
    const started = Date.now();
    // A long grace that a flooding process would otherwise get: overflow
    // must skip it and SIGKILL straight away.
    const r = await new RealQmdExecutor({ binary: fake, killGraceMs: 10_000 }).execute(['update']);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(r.failure).toMatchObject({ kind: 'output_overflow' });
    expect(describeQmdFailure(['update'], r).message).toContain('process group was terminated');
  }, 15_000);

  it.each(['missing-binary', 'invalid-null-byte'])(
    'releases signal handlers after %s spawn failure',
    async (kind) => {
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const;
      const hostHandler = () => {};
      process.on('SIGINT', hostHandler);
      const before = signals.map((signal) => process.listenerCount(signal));
      try {
        const binary = kind === 'missing-binary' ? join(dir, 'missing-qmd') : '\0';
        const result = await new RealQmdExecutor({ binary }).execute(['update']);
        expect(result.failure?.kind).toBe('spawn');
        expect(liveGroupCount()).toBe(0);
        expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before);
        expect(process.listeners('SIGINT')).toContain(hostHandler);
      } finally {
        process.off('SIGINT', hostHandler);
      }
    },
  );

  it('a successful run is unchanged: stdout, stderr and exit 0', async () => {
    const fake = script('ok-qmd', 'echo "args:$*"\necho warn >&2');
    const r = await new RealQmdExecutor({ binary: fake }).execute(['search', '--json', '--', 'x']);
    expect(r).toEqual({ stdout: 'args:search --json -- x\n', stderr: 'warn\n', exitCode: 0 });
    expect(liveGroupCount()).toBe(0);
  });

  async function sigintHost(
    fake: string,
  ): Promise<{ exitSignal: NodeJS.Signals | null; grandchild: number }> {
    const host = join(dir, 'host.mts');
    const executorPath = resolve(HERE, '../executor/real-executor.ts');
    writeFileSync(
      host,
      `import { RealQmdExecutor } from ${JSON.stringify(executorPath)};\n` +
        `await new RealQmdExecutor({ binary: ${JSON.stringify(fake)}, maintenanceTimeout: 60000 }).execute(['update']);\n`,
    );
    // Plain `node` (tsx only as an --import loader) so the SIGINT lands on the
    // host itself with Node's default disposition — no wrapper relaying it.
    const loader = pathToFileURL(resolve(HERE, '../../../../node_modules/tsx/dist/loader.mjs'));
    const child = spawn(process.execPath, ['--import', loader.href, host], { stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_c, sig) => r(sig)));
    const grandchild = Number(await waitForFile(pidFile, 10_000));
    expect(alive(grandchild)).toBe(true);
    child.kill('SIGINT');
    return { exitSignal: await exited, grandchild };
  }

  it('a SIGINT to the host process still takes the detached qmd group down', async () => {
    // Detaching qmd into its own group means a terminal Ctrl-C no longer
    // reaches it; the executor must forward it, or interrupting `reindex`
    // would recreate the orphan. Drive a real host process to prove it.
    const fake = script('slow-qmd', `sleep 300 &\necho $! > "${pidFile}"\nwait`);
    const { exitSignal, grandchild } = await sigintHost(fake);
    // The executor signals the qmd group, then re-raises SIGINT (no other
    // listener) so the host still dies of it — with no survivor left behind.
    expect(exitSignal).toBe('SIGINT');
    expect(await waitGone(grandchild)).toBe(true);
  }, 30_000);

  it('owns a child when SIGINT arrives before spawn returns to the executor', async () => {
    const fake = script('spawn-race-qmd', `sleep 300 &\necho $! > "${pidFile}"\nwait`);
    const host = join(dir, 'spawn-race-host.mts');
    const executorPath = resolve(HERE, '../executor/real-executor.ts');
    // Widen the real registration gap deterministically: spawn a real launcher,
    // wait for its grandchild, then signal the host before returning its PID to
    // the executor. An unhandled SIGINT has Node's default fatal disposition.
    writeFileSync(
      host,
      `import childProcess from 'node:child_process';\n` +
        `import { syncBuiltinESMExports } from 'node:module';\n` +
        `import { existsSync, readFileSync } from 'node:fs';\n` +
        `const original = childProcess.spawn;\n` +
        `childProcess.spawn = (...args) => {\n` +
        `  const child = original(...args);\n` +
        `  const pause = new Int32Array(new SharedArrayBuffer(4));\n` +
        `  const deadline = Date.now() + 5000;\n` +
        `  while ((!existsSync(${JSON.stringify(pidFile)}) || readFileSync(${JSON.stringify(pidFile)}, 'utf8').trim() === '') && Date.now() < deadline) Atomics.wait(pause, 0, 0, 5);\n` +
        `  process.kill(process.pid, 'SIGINT');\n` +
        `  Atomics.wait(pause, 0, 0, 50);\n` +
        `  return child;\n` +
        `};\n` +
        `syncBuiltinESMExports();\n` +
        `const { RealQmdExecutor } = await import(${JSON.stringify(executorPath)});\n` +
        `await new RealQmdExecutor({ binary: ${JSON.stringify(fake)}, maintenanceTimeout: 60000 }).execute(['update']);\n`,
    );
    const loader = pathToFileURL(resolve(HERE, '../../../../node_modules/tsx/dist/loader.mjs'));
    const child = spawn(process.execPath, ['--import', loader.href, host], { stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_c, sig) => r(sig)));
    const grandchild = Number(await waitForFile(pidFile, 10_000));
    expect(await exited).toBe('SIGINT');
    expect(await waitGone(grandchild)).toBe(true);
  }, 30_000);

  it('a SIGINT to the host SIGKILLs a qmd group that ignores SIGTERM', async () => {
    const fake = script(
      'stubborn-qmd',
      `sh -c 'trap "" TERM; echo $$ > "${pidFile}"; while :; do sleep 1; done' &\nwait`,
    );
    const { exitSignal, grandchild } = await sigintHost(fake);
    expect(exitSignal).toBe('SIGINT');
    expect(await waitGone(grandchild)).toBe(true);
  }, 30_000);
});

describe('timeout budgets', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[QMD_TIMEOUT_ENV];
    delete process.env[QMD_TIMEOUT_ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[QMD_TIMEOUT_ENV];
    else process.env[QMD_TIMEOUT_ENV] = saved;
  });

  it('classifies index-maintenance commands', () => {
    expect(isMaintenanceCommand(['update'])).toBe(true);
    expect(isMaintenanceCommand(['embed', '-f'])).toBe(true);
    expect(isMaintenanceCommand(['cleanup'])).toBe(true);
    expect(isMaintenanceCommand(['collection', 'add', '/x', '--name', 'kb-guides'])).toBe(true);
    expect(isMaintenanceCommand(['collection', 'list'])).toBe(false);
    expect(isMaintenanceCommand(['search', '--json', '--', 'update'])).toBe(false);
    expect(isMaintenanceCommand(['--version'])).toBe(false);
  });

  it('defaults: query keeps 30 s, maintenance gets 10 min', () => {
    const exec = new RealQmdExecutor({ binary: '/bin/true' });
    expect(DEFAULT_TIMEOUT).toBe(30_000);
    expect(DEFAULT_MAINTENANCE_TIMEOUT).toBe(600_000);
    expect(exec.timeoutFor(['search', '--json', '--', 'q'])).toBe(30_000);
    expect(exec.timeoutFor(['update'])).toBe(600_000);
  });

  it('TEAMKB_QMD_TIMEOUT_MS overrides maintenance only, never the query budget', () => {
    process.env[QMD_TIMEOUT_ENV] = '1200000';
    const exec = new RealQmdExecutor({ binary: '/bin/true' });
    expect(exec.timeoutFor(['update'])).toBe(1_200_000);
    expect(exec.timeoutFor(['search', '--json', '--', 'q'])).toBe(30_000);
  });

  it('an invalid env value falls back to the default in the library', () => {
    process.env[QMD_TIMEOUT_ENV] = '10m';
    expect(new RealQmdExecutor({ binary: '/bin/true' }).timeoutFor(['update'])).toBe(600_000);
  });

  it('an explicit option beats the env', () => {
    process.env[QMD_TIMEOUT_ENV] = '1200000';
    const exec = new RealQmdExecutor({ binary: '/bin/true', maintenanceTimeout: 5_000 });
    expect(exec.timeoutFor(['update'])).toBe(5_000);
  });
});
