import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { QmdExecutor } from './executor.js';
import type { CommandResult } from '../types.js';
import { DEFAULT_QMD_BINARY, DEFAULT_TIMEOUT } from '../config.js';

const execFileAsync = promisify(execFile);

/** Real qmd CLI executor using child_process */
export class RealQmdExecutor implements QmdExecutor {
  private readonly binary: string;
  private readonly timeout: number;
  private readonly env: Record<string, string> | null;

  /**
   * @param options.env Environment overrides merged over `process.env` for every
   *   qmd invocation. qmd 2.0.1 has **no `--data-dir` flag** — per-tenant index
   *   and registry isolation is achieved by pointing `XDG_CONFIG_HOME`
   *   (collection registry) and `XDG_CACHE_HOME` (BM25 index) at tenant-scoped
   *   dirs. See `getQmdTenantEnv` in `config.ts` and ADR
   *   `000-docs/037-AT-DSGN-qmd-adapter-source-index-separation.md`.
   */
  constructor(options?: { binary?: string; timeout?: number; env?: Record<string, string> }) {
    this.binary = options?.binary ?? DEFAULT_QMD_BINARY;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.env = options?.env ?? null;
  }

  async execute(args: string[]): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync(this.binary, args, {
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024,
        // Merge over process.env so PATH (qmd discovery) is preserved while
        // tenant-scoped XDG_* vars isolate the registry + index.
        ...(this.env ? { env: { ...process.env, ...this.env } } : {}),
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (e: unknown) {
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
