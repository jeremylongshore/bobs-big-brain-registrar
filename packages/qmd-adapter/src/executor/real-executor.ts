import { spawn, type ChildProcess } from 'node:child_process';
import type { QmdExecutor } from './executor.js';
import type { CommandFailure, CommandResult } from '../types.js';
import { delimiter, dirname, isAbsolute } from 'node:path';
import { DEFAULT_TIMEOUT, resolveMaintenanceTimeoutMs } from '../config.js';
import { QMD_NOT_FOUND_EXIT_CODE, resolveQmdBinary } from './resolve-binary.js';
import { beginGroupSpawn, trackGroup, untrackGroup } from './process-groups.js';

/** Exit code reported for a run that hit its time limit (coreutils `timeout` convention). */
export const QMD_TIMEOUT_EXIT_CODE = 124;

/** Default wait between SIGTERM and SIGKILL when a qmd run is terminated. */
export const DEFAULT_KILL_GRACE_MS = 5_000;

/** Cap on captured stdout/stderr per run (the old execFile `maxBuffer`). */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** How often to probe whether a terminated process group has fully exited. */
const GROUP_POLL_MS = 50;

/** After SIGKILL, how long to wait for the kernel to reap the group before reporting. */
const POST_KILL_WAIT_MS = 2_000;

/** POSIX process groups exist; Windows has no `kill(-pgid)`. */
const USE_PROCESS_GROUP = process.platform !== 'win32';

/**
 * qmd sub-commands that build or rewrite the index. They get the long
 * maintenance budget; everything else (search, `collection list`, `status`,
 * `--version`) keeps the interactive {@link DEFAULT_TIMEOUT}.
 */
export function isMaintenanceCommand(args: readonly string[]): boolean {
  const [cmd, sub] = args;
  if (cmd === 'update' || cmd === 'embed' || cmd === 'cleanup') return true;
  return cmd === 'collection' && sub === 'add';
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True while any process in group `pgid` still exists. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    // EPERM = members exist but belong to someone else — still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (USE_PROCESS_GROUP) process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/** Poll until the group is gone or `ms` elapses; returns whether it is gone. */
async function waitGroupGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(GROUP_POLL_MS);
  }
  return true;
}

/** Real qmd CLI executor using child_process */
export class RealQmdExecutor implements QmdExecutor {
  private readonly explicitBinary: string | undefined;
  private resolved: string | null = null;
  private readonly timeout: number;
  private readonly maintenanceTimeout: number;
  private readonly killGraceMs: number;
  private readonly env: Record<string, string> | null;

  /**
   * @param options.env Environment overrides merged over `process.env` for every
   *   qmd invocation. qmd 2.x has **no `--data-dir` flag** — per-tenant index
   *   and registry isolation is achieved by pointing `XDG_CONFIG_HOME`
   *   (collection registry) and `XDG_CACHE_HOME` (BM25 index) at tenant-scoped
   *   dirs. See `getQmdTenantEnv` in `config.ts` and ADR
   *   `000-docs/037-AT-DSGN-qmd-adapter-source-index-separation.md`.
   * @param options.timeout Limit for interactive commands (default 30 s).
   * @param options.maintenanceTimeout Limit for update/embed/cleanup/collection
   *   add (default `TEAMKB_QMD_TIMEOUT_MS`, else 600 s).
   * @param options.killGraceMs SIGTERM→SIGKILL grace when a run is terminated.
   */
  constructor(options?: {
    binary?: string;
    timeout?: number;
    maintenanceTimeout?: number;
    killGraceMs?: number;
    env?: Record<string, string>;
  }) {
    // An explicit binary is used verbatim (callers/tests pin exactly what runs).
    // With none, discovery is deferred to execute() — see resolveBinary().
    this.explicitBinary = options?.binary;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.maintenanceTimeout = options?.maintenanceTimeout ?? resolveMaintenanceTimeoutMs();
    this.killGraceMs = options?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.env = options?.env ?? null;
  }

  /** The limit that applies to `args` (maintenance vs interactive). */
  timeoutFor(args: readonly string[]): number {
    return isMaintenanceCommand(args) ? this.maintenanceTimeout : this.timeout;
  }

  /**
   * The binary to run, or the actionable reason there is none. Discovery order
   * (env var, PATH, `~/.bun/bin/qmd`) lives in {@link resolveQmdBinary}. A
   * successful resolution is cached; a failure is NOT, so installing qmd (or
   * fixing the env) takes effect on the next call without a restart.
   */
  private resolveBinary(): { binary: string; message?: undefined } | { message: string } {
    if (this.explicitBinary !== undefined) return { binary: this.explicitBinary };
    if (this.resolved !== null) return { binary: this.resolved };
    try {
      this.resolved = resolveQmdBinary().path;
      return { binary: this.resolved };
    } catch (e) {
      return { message: e instanceof Error ? e.message : String(e) };
    }
  }

  async execute(args: string[]): Promise<CommandResult> {
    const target = this.resolveBinary();
    if (target.message !== undefined) {
      // 127 = "command not found" by shell convention; stderr carries the fix.
      return { stdout: '', stderr: target.message, exitCode: QMD_NOT_FOUND_EXIT_CODE };
    }
    // Merge over process.env so tenant-scoped XDG_* vars isolate the registry +
    // index. An absolute binary's own directory is prepended to PATH: qmd is a
    // launcher script that re-execs node/bun, which can live beside it
    // (~/.bun/bin) while being absent from an MCP server's PATH.
    const env: Record<string, string | undefined> = { ...process.env, ...(this.env ?? {}) };
    if (isAbsolute(target.binary)) {
      env['PATH'] = [dirname(target.binary), env['PATH']].filter((p) => p).join(delimiter);
    }
    return this.run(target.binary, args, env, this.timeoutFor(args));
  }

  /**
   * Spawn qmd in its OWN process group and own its whole lifetime.
   *
   * Why not `execFile({ timeout })` (bead compile-then-govern-39z.20): the qmd
   * binary is a launcher that spawns `node dist/cli/qmd.js` and does not
   * forward SIGTERM. execFile's timeout signals only the launcher, so the
   * launcher died, the real `qmd update` was reparented to PID 1 and kept
   * writing the index after the wrapper had already reported "Failed to update
   * index". Here a timeout signals the whole group (SIGTERM, then SIGKILL after
   * the grace), then bounded disappearance checks report whether that tracked
   * group is gone. A descendant that leaves the process group is outside this
   * ownership boundary; a failed disappearance check is not a cleanup guarantee.
   */
  private run(
    binary: string,
    args: string[],
    env: Record<string, string | undefined>,
    timeoutMs: number,
  ): Promise<CommandResult> {
    const startedAt = Date.now();
    return new Promise<CommandResult>((resolve) => {
      let child: ChildProcess;
      const releaseSpawn = USE_PROCESS_GROUP ? beginGroupSpawn() : undefined;
      try {
        child = spawn(binary, args, {
          env,
          detached: USE_PROCESS_GROUP,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        releaseSpawn?.();
        resolve(this.spawnFailure(binary, e));
        return;
      }
      const pid = child.pid;
      if (pid !== undefined && USE_PROCESS_GROUP) trackGroup(pid);
      releaseSpawn?.();

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let bytes = 0;
      let failure: CommandFailure | undefined;
      let terminating: Promise<boolean> | null = null;
      // `hard` skips the SIGTERM grace: a process flooding its pipes is not
      // going to honour a polite request.
      const terminate = (hard = false): Promise<boolean> => {
        if (terminating !== null) return terminating;
        if (pid === undefined) return (terminating = Promise.resolve(true));
        terminating = (async () => {
          if (!USE_PROCESS_GROUP) {
            // No process groups (Windows): only the direct child can be
            // signalled, so its descendants can never be confirmed gone.
            signalGroup(pid, 'SIGKILL');
            return false;
          }
          if (!hard) {
            signalGroup(pid, 'SIGTERM');
            if (await waitGroupGone(pid, this.killGraceMs)) return true;
          }
          signalGroup(pid, 'SIGKILL');
          const gone = await waitGroupGone(pid, POST_KILL_WAIT_MS);
          // Release our pipe ends so 'close' fires even if something outside
          // the group (a setsid'd descendant) still holds them.
          child.stdout?.destroy();
          child.stderr?.destroy();
          return gone;
        })();
        return terminating;
      };

      const collect =
        (sink: Buffer[]) =>
        (chunk: Buffer): void => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT_BYTES) {
            if (failure === undefined) {
              failure = {
                kind: 'output_overflow',
                limitBytes: MAX_OUTPUT_BYTES,
                elapsedMs: Date.now() - startedAt,
              };
              void terminate(true);
            }
            return;
          }
          sink.push(chunk);
        };
      child.stdout?.on('data', collect(out));
      child.stderr?.on('data', collect(err));

      const timer = setTimeout(() => {
        if (failure !== undefined) return;
        failure = {
          kind: 'timeout',
          elapsedMs: Date.now() - startedAt,
          timeoutMs,
          groupTerminated: false,
        };
        void terminate();
      }, timeoutMs);

      child.on('error', (e) => {
        // A failed spawn has no pid and may never emit 'close' — settle now.
        if (pid === undefined) {
          clearTimeout(timer);
          resolve(this.spawnFailure(binary, e));
        }
      });

      // 'close' = the launcher exited AND every inherited stdio pipe closed,
      // i.e. every group member that held one is gone too.
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        void (async () => {
          if (failure !== undefined && pid !== undefined) {
            const gone = await terminate();
            if (failure.kind === 'timeout') failure.groupTerminated = gone;
          }
          if (pid === undefined) return; // settled by the 'error' handler
          if (USE_PROCESS_GROUP) untrackGroup(pid);
          const stdout = Buffer.concat(out).toString('utf8');
          const stderr = Buffer.concat(err).toString('utf8');
          if (failure?.kind === 'timeout') {
            resolve({ stdout, stderr, exitCode: QMD_TIMEOUT_EXIT_CODE, failure });
          } else if (failure !== undefined) {
            resolve({ stdout, stderr, exitCode: 1, failure });
          } else if (signal !== null) {
            resolve({
              stdout,
              stderr,
              exitCode: 128 + (SIGNAL_NUMBERS[signal] ?? 0),
              failure: { kind: 'signal', signal, elapsedMs: Date.now() - startedAt },
            });
          } else {
            resolve({ stdout, stderr, exitCode: code ?? 1 });
          }
        })();
      });
    });
  }

  /**
   * A pinned `binary` option skips discovery, so a bad path only shows up as a
   * spawn error. ENOENT/EACCES get the same actionable 127 shape as a failed
   * discovery; anything else is reported as a spawn failure with its code.
   */
  private spawnFailure(binary: string, e: unknown): CommandResult {
    const code = (e as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN';
    const message = e instanceof Error ? e.message : String(e);
    if (code === 'ENOENT' || code === 'EACCES') {
      return {
        stdout: '',
        stderr:
          `qmd binary "${binary}" cannot be executed (${code}). Fix the qmdBinary option ` +
          `or TEAMKB_QMD_BIN, or omit it to search PATH and ~/.bun/bin/qmd.`,
        exitCode: QMD_NOT_FOUND_EXIT_CODE,
        failure: { kind: 'spawn', code, message },
      };
    }
    return {
      stdout: '',
      stderr: `qmd binary "${binary}" failed to start (${code}): ${message}`,
      exitCode: QMD_NOT_FOUND_EXIT_CODE,
      failure: { kind: 'spawn', code, message },
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.execute(['--version']);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
