import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BRAINIGNORE_PATTERNS,
  compilePattern,
  parseBrainignore,
  type BrainignoreRuleset,
} from './brainignore.js';

/** Environment variable overriding the per-brain brainignore file location. */
export const BRAINIGNORE_PATH_ENV = 'TEAMKB_BRAINIGNORE';

/** Default per-brain override file: `~/.teamkb/brainignore`. */
export function defaultBrainignorePath(): string {
  return join(homedir(), '.teamkb', 'brainignore');
}

/** Options for {@link loadBrainignoreRuleset}. */
export interface LoadBrainignoreOptions {
  /** Explicit override-file path (wins over the env var and the default). */
  path?: string;
  /**
   * Called when an override file exists but cannot be read/parsed. The loader
   * NEVER throws — an unreadable override degrades to defaults-only with a
   * warning, because a broken operator file must not stall the whole govern
   * pipeline (same containment posture as the origin-secret resolution).
   */
  onWarn?: (message: string) => void;
}

/**
 * Build the effective brainignore ruleset for this brain: the committed
 * defaults, plus the per-brain override file appended AFTER them (last match
 * wins, so an override `!pattern` line re-admits a default exclusion).
 *
 * Resolution order for the override file: explicit `path` option → the
 * `TEAMKB_BRAINIGNORE` env var → `~/.teamkb/brainignore`. A missing file is
 * normal (defaults-only); an unreadable file warns and degrades to defaults.
 */
export function loadBrainignoreRuleset(options: LoadBrainignoreOptions = {}): BrainignoreRuleset {
  const overridePath =
    options.path ?? process.env[BRAINIGNORE_PATH_ENV] ?? defaultBrainignorePath();

  const defaults = DEFAULT_BRAINIGNORE_PATTERNS.map((p) => compilePattern(p, 'default')).filter(
    (p): p is NonNullable<typeof p> => p !== null,
  );

  let text: string;
  try {
    text = readFileSync(overridePath, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      options.onWarn?.(
        `brainignore override at ${overridePath} could not be read (${
          e instanceof Error ? e.message : String(e)
        }) — continuing with the committed defaults only`,
      );
    }
    return { patterns: defaults, overridePath: null };
  }

  const overrides = parseBrainignore(text, 'override');
  return { patterns: [...defaults, ...overrides], overridePath };
}
