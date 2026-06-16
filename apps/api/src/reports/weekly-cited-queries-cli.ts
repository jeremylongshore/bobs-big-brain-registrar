/**
 * CLI: weekly cited-query count per teammate.
 *
 *   node dist/reports/weekly-cited-queries-cli.js [--days N] [--json] [--unit NAME] [--stdin]
 *
 * Reads the `teamkb-brain-api` access log from the systemd **user** journal and
 * prints (or emits JSON for) the per-actor cited-query report. journald on the
 * brain host is persistent, so the journal *is* the durable access log — no
 * extra store needed. If the access log is ever teed to a file, pass `--stdin`
 * and pipe it in; the aggregator ({@link summarizeCitedQueries}) is
 * source-agnostic.
 *
 * Intended to be run weekly (cron or the notification hub, spine-zm9) with
 * `--json` to post the roll-up to ntfy/Slack.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { summarizeCitedQueries, rollingWindow, formatReport } from './cited-queries.js';

/** Parsed command-line options. */
export interface CliOptions {
  days: number;
  json: boolean;
  unit: string;
  stdin: boolean;
}

/** The default systemd user unit the brain API runs under. */
export const DEFAULT_UNIT = 'teamkb-brain-api.service';

/** Parse argv (after `node script.js`) into {@link CliOptions}. Pure. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { days: 7, json: false, unit: DEFAULT_UNIT, stdin: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--stdin') {
      opts.stdin = true;
    } else if (arg === '--days') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('--days requires a positive integer');
      }
      opts.days = value;
      i++;
    } else if (arg === '--unit') {
      const value = argv[i + 1];
      if (value === undefined || value === '') {
        throw new Error('--unit requires a unit name');
      }
      opts.unit = value;
      i++;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }

  return opts;
}

/** A spawn function shaped like {@link spawnSync} — injectable for tests. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { encoding: 'utf8' },
) => SpawnSyncReturns<string>;

/** Format an epoch-ms instant as a local `YYYY-MM-DD HH:MM:SS` for journalctl `--since`. */
export function formatSince(sinceMs: number): string {
  const d = new Date(sinceMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Read access-log lines from the user journal for `unit` since `sinceMs`.
 *
 * `--since` is only a coarse pre-filter to bound how much journald scans; the
 * aggregator re-filters by exact event timestamp, so the window is precise even
 * if journald rounds the `--since` boundary.
 */
export function readJournalLines(
  unit: string,
  sinceMs: number,
  spawn: SpawnFn = spawnSync,
): string[] {
  const result = spawn(
    'journalctl',
    ['--user', '-u', unit, '--since', formatSince(sinceMs), '-o', 'cat', '--no-pager'],
    { encoding: 'utf8' },
  );
  if (result.error) {
    throw new Error(`failed to read journal: ${result.error.message}`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`journalctl exited ${result.status}: ${(result.stderr ?? '').trim()}`);
  }
  return (result.stdout ?? '').split('\n');
}

/**
 * Build the report and render it. Pure relative to its inputs (no journal/stdin
 * read) so it is fully unit-testable; `main()` supplies `lines` and `nowMs`.
 */
export function runReport(lines: Iterable<string>, nowMs: number, opts: CliOptions): string {
  const report = summarizeCitedQueries(lines, rollingWindow(nowMs, opts.days));
  return opts.json ? JSON.stringify(report, null, 2) : formatReport(report);
}

/** CLI entrypoint. Thin glue over the tested functions above. */
export function main(argv: readonly string[], nowMs: number): void {
  const opts = parseArgs(argv);
  const lines = opts.stdin
    ? readFileSync(0, 'utf8').split('\n')
    : readJournalLines(opts.unit, rollingWindow(nowMs, opts.days).sinceMs);
  process.stdout.write(`${runReport(lines, nowMs, opts)}\n`);
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2), Date.now());
}
