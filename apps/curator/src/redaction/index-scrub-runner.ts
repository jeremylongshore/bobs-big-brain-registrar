/**
 * Run the derived-index scrub after a redaction (umbrella bead
 * compile-then-govern-39z.19; runbook 000-docs/054-OD-RNBK §4.7).
 *
 * The scrub lives in `@qmd-team-intent-kb/qmd-adapter`, which owns the index
 * layout (qmd's cache schema, the native FTS5 and dense sidecars, the
 * collection registry). The curator is govern-side and must build and test
 * with that package DELETED (the `delete-compile` seam-independence gate and
 * the `no-govern-imports-retrieval` rule), so it does not import it: it runs
 * the scrub as a child process, `qmd-index scrub-index --json`, and reads the
 * JSON envelope back. The removed fragments travel on the child's stdin as a
 * JSON array — in memory only, never in argv (visible in `ps`) and never on
 * disk.
 *
 * @module redaction/index-scrub-runner
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The CLI's exit codes this runner interprets. */
const SCRUB_EXIT_OK = 0;
const SCRUB_EXIT_INCOMPLETE = 4;
const SCRUB_EXIT_SCHEMA_REFUSED = 5;

/** What the redact report shows about the index scrub. Counts and paths only. */
export interface IndexScrubOutcome {
  /** False when the scrub did not run (no index dir, tool not found, opted out). */
  ran: boolean;
  /** True when nothing is left to do: scrubbed clean, or there was no index. */
  complete: boolean;
  indexDir: string;
  exportDir: string;
  /** Why it did not run, or why it is incomplete, in one line. */
  note: string | null;
  /** The child's exit code, when it ran. */
  exitCode: number | null;
  /** The child's JSON envelope (snake_case, counts and paths only), when it ran. */
  report: Record<string, unknown> | null;
}

export interface IndexScrubRequest {
  indexDir: string;
  exportDir: string;
  memoryId: string;
  /** Removed text. Passed on stdin, never persisted. */
  fragments: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Override the CLI path (tests); else TEAMKB_QMD_INDEX_CLI, else the monorepo path. */
  cliPath?: string;
}

/** Default index and export dirs: siblings of the store, as in `<base>/teamkb.db`. */
export function defaultIndexDirs(dbPath: string): { indexDir: string; exportDir: string } {
  const base = dirname(resolve(dbPath));
  return { indexDir: join(base, 'qmd-index'), exportDir: join(base, 'kb-export') };
}

/**
 * The `qmd-index` CLI: `TEAMKB_QMD_INDEX_CLI`, else the workspace build at
 * `packages/qmd-adapter/dist/cli.js` (this file sits four levels below the
 * repo root in both `src/` and `dist/`).
 */
export function resolveIndexScrubCli(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env['TEAMKB_QMD_INDEX_CLI']?.trim();
  if (pinned) return resolve(pinned);
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  return join(root, 'packages', 'qmd-adapter', 'dist', 'cli.js');
}

function notRun(req: IndexScrubRequest, complete: boolean, note: string): IndexScrubOutcome {
  return {
    ran: false,
    complete,
    indexDir: req.indexDir,
    exportDir: req.exportDir,
    note,
    exitCode: null,
    report: null,
  };
}

function parseEnvelope(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split('\n').pop() ?? '';
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function noteFor(
  exitCode: number | null,
  report: Record<string, unknown> | null,
  stderr: string,
): string | null {
  if (exitCode === SCRUB_EXIT_OK && report !== null) return null;
  if (exitCode === SCRUB_EXIT_SCHEMA_REFUSED) {
    return 'an index file has an unexpected table layout (qmd version drift) and was not touched';
  }
  if (exitCode === SCRUB_EXIT_INCOMPLETE) {
    return 'an index was busy, a step failed, a mass removal was refused, or removed text remains';
  }
  const detail = stderr.trim().split('\n')[0] ?? '';
  return `the index scrub failed (exit ${exitCode ?? 'signal'})${detail ? `: ${detail}` : ''}`;
}

/**
 * Scrub every tenant's derived index for a redacted memory and byte-scan the
 * index files for the removed fragments. Never throws.
 */
export function runIndexScrub(req: IndexScrubRequest): IndexScrubOutcome {
  if (!existsSync(req.indexDir)) {
    return notRun(req, true, `no index directory at ${req.indexDir}`);
  }
  const cli = req.cliPath ?? resolveIndexScrubCli(req.env);
  if (!existsSync(cli)) {
    return notRun(
      req,
      false,
      `index scrub tool not found at ${cli} (build the workspace, or set TEAMKB_QMD_INDEX_CLI)`,
    );
  }
  const args = [
    cli,
    'scrub-index',
    '--json',
    '--index-dir',
    req.indexDir,
    '--export-dir',
    req.exportDir,
    '--drop-memory-id',
    req.memoryId,
    '--explained-residual-ok',
    '--fragments-stdin',
  ];
  const child = spawnSync(process.execPath, args, {
    input: JSON.stringify(req.fragments),
    encoding: 'utf8',
    env: req.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error !== undefined) {
    return notRun(req, false, `index scrub could not start: ${child.error.message}`);
  }
  const report = parseEnvelope(child.stdout);
  const exitCode = child.status;
  return {
    ran: true,
    complete: exitCode === SCRUB_EXIT_OK && report !== null && report['complete'] === true,
    indexDir: req.indexDir,
    exportDir: req.exportDir,
    note: noteFor(exitCode, report, child.stderr),
    exitCode,
    report,
  };
}
