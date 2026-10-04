import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** Env var that pins the qmd binary explicitly (highest-priority discovery source). */
export const QMD_BIN_ENV = 'TEAMKB_QMD_BIN';

/**
 * Exit code the real executor reports when no qmd binary could be located
 * (shell convention for "command not found"). Its stderr is the actionable
 * {@link QmdBinaryNotFoundError} message.
 */
export const QMD_NOT_FOUND_EXIT_CODE = 127;

/** Where a resolved binary came from — reported so an operator can see why this qmd ran. */
export type QmdBinarySource = 'explicit' | 'env' | 'path' | 'bun-default';

export interface ResolvedQmdBinary {
  /** Absolute path to an executable file. */
  path: string;
  source: QmdBinarySource;
}

/** Injectable seams so resolution is testable without touching the real filesystem. */
export interface ResolveQmdBinaryOptions {
  /** Explicit path from caller config (e.g. `QmdAdapterConfig.qmdBinary`). */
  explicit?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Home dir used for the `~/.bun/bin/qmd` fallback. */
  home?: string;
  /** Executable-file probe. Defaults to a real fs check. */
  isExecutable?: (path: string) => boolean;
}

/**
 * No qmd binary could be located. The message names every place that was
 * searched and the fix, so an MCP/daemon operator whose environment lacks `qmd`
 * on PATH gets an actionable line instead of an opaque "Failed to update index".
 */
export class QmdBinaryNotFoundError extends Error {
  constructor(
    message: string,
    readonly searched: readonly string[],
  ) {
    super(message);
    this.name = 'QmdBinaryNotFoundError';
  }
}

function defaultIsExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the qmd binary. Order (first hit wins):
 *
 *  1. `explicit` (adapter config) — if set it MUST be usable; a broken explicit
 *     choice is an error, never silently replaced by a different qmd.
 *  2. `TEAMKB_QMD_BIN` — same rule: set but unusable is an error.
 *  3. `qmd` on `PATH`.
 *  4. `~/.bun/bin/qmd` — where `bun add -g @tobilu/qmd` installs it; MCP/cron
 *     environments routinely lack `~/.bun/bin` on PATH.
 *
 * @throws {QmdBinaryNotFoundError} when nothing usable is found.
 */
export function resolveQmdBinary(options: ResolveQmdBinaryOptions = {}): ResolvedQmdBinary {
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const searched: string[] = [];

  const pinned = (
    value: string | undefined,
    source: 'explicit' | 'env',
    label: string,
  ): ResolvedQmdBinary | null => {
    const v = value?.trim();
    if (v === undefined || v === '') return null;
    searched.push(`${label}=${v}`);
    // A bare command name ("qmd") is a PATH lookup, not a path.
    if (!isAbsolute(v) && !v.includes('/')) {
      const hit = findOnPath(v, env, isExecutable);
      if (hit !== null) return { path: hit, source };
      throw new QmdBinaryNotFoundError(
        `${label} is set to "${v}" but no executable by that name is on PATH. ` +
          `Fix ${label}, or unset it to fall back to PATH and ~/.bun/bin/qmd.`,
        searched,
      );
    }
    if (isExecutable(v)) return { path: v, source };
    throw new QmdBinaryNotFoundError(
      `${label} is set to "${v}" but that is not an executable file. ` +
        `Fix ${label}, or unset it to fall back to PATH and ~/.bun/bin/qmd.`,
      searched,
    );
  };

  const fromExplicit = pinned(options.explicit, 'explicit', 'qmdBinary');
  if (fromExplicit !== null) return fromExplicit;
  const fromEnv = pinned(env[QMD_BIN_ENV], 'env', QMD_BIN_ENV);
  if (fromEnv !== null) return fromEnv;

  const onPath = findOnPath('qmd', env, isExecutable);
  searched.push('PATH');
  if (onPath !== null) return { path: onPath, source: 'path' };

  const bunDefault = join(options.home ?? homedir(), '.bun', 'bin', 'qmd');
  searched.push(bunDefault);
  if (isExecutable(bunDefault)) return { path: bunDefault, source: 'bun-default' };

  throw new QmdBinaryNotFoundError(
    `qmd binary not found (searched: ${searched.join(', ')}). The search index cannot be ` +
      `refreshed until it is available. Install it (bun add -g @tobilu/qmd) and either put it ` +
      `on PATH or set ${QMD_BIN_ENV}=/absolute/path/to/qmd in the MCP server environment, ` +
      `then re-run.`,
    searched,
  );
}

function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  isExecutable: (p: string) => boolean,
): string | null {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}
