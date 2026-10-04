import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { QmdExecutor } from './executor.js';
import type { CommandResult } from '../types.js';
import { delimiter, dirname, isAbsolute } from 'node:path';
import { DEFAULT_TIMEOUT } from '../config.js';
import { QMD_NOT_FOUND_EXIT_CODE, resolveQmdBinary } from './resolve-binary.js';

const execFileAsync = promisify(execFile);

/** Real qmd CLI executor using child_process */
export class RealQmdExecutor implements QmdExecutor {
  private readonly explicitBinary: string | undefined;
  private resolved: string | null = null;
  private readonly timeout: number;
  private readonly env: Record<string, string> | null;

  /**
   * @param options.env Environment overrides merged over `process.env` for every
   *   qmd invocation. qmd 2.x has **no `--data-dir` flag** — per-tenant index
   *   and registry isolation is achieved by pointing `XDG_CONFIG_HOME`
   *   (collection registry) and `XDG_CACHE_HOME` (BM25 index) at tenant-scoped
   *   dirs. See `getQmdTenantEnv` in `config.ts` and ADR
   *   `000-docs/037-AT-DSGN-qmd-adapter-source-index-separation.md`.
   */
  constructor(options?: { binary?: string; timeout?: number; env?: Record<string, string> }) {
    // An explicit binary is used verbatim (callers/tests pin exactly what runs).
    // With none, discovery is deferred to execute() — see resolveBinary().
    this.explicitBinary = options?.binary;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.env = options?.env ?? null;
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
    const binary = target.binary;
    try {
      // Merge over process.env so tenant-scoped XDG_* vars isolate the registry +
      // index. An absolute binary's own directory is prepended to PATH: qmd is a
      // launcher script that re-execs node/bun, which can live beside it
      // (~/.bun/bin) while being absent from an MCP server's PATH.
      const env: Record<string, string | undefined> = { ...process.env, ...(this.env ?? {}) };
      if (isAbsolute(binary)) {
        env['PATH'] = [dirname(binary), env['PATH']].filter((p) => p).join(delimiter);
      }
      const { stdout, stderr } = await execFileAsync(binary, args, {
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024,
        env,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (e: unknown) {
      // A pinned `binary` option skips discovery, so a bad path only shows up as a
      // spawn error here. Give it the same actionable shape as a failed discovery
      // instead of an empty-stderr exit 1.
      const spawnCode =
        e && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : undefined;
      if (spawnCode === 'ENOENT' || spawnCode === 'EACCES') {
        return {
          stdout: '',
          stderr:
            `qmd binary "${binary}" cannot be executed (${spawnCode}). Fix the qmdBinary option ` +
            `or TEAMKB_QMD_BIN, or omit it to search PATH and ~/.bun/bin/qmd.`,
          exitCode: QMD_NOT_FOUND_EXIT_CODE,
        };
      }
      if (e && typeof e === 'object' && 'stdout' in e && 'stderr' in e && 'code' in e) {
        const err = e as { stdout: string; stderr: string; code: number | string };
        return {
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
          exitCode: typeof err.code === 'number' ? err.code : 1,
        };
      }
      return { stdout: '', stderr: String(e), exitCode: 1 };
    }
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
