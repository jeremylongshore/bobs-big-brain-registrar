import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getQmdIndexBasePath } from '../config.js';
import { formatIndexScrub, indexScrubJson } from './format.js';
import { readFragmentsFile } from './fragments-file.js';
import { scrubIndexes } from './index-scrub.js';

/**
 * `qmd-index scrub-index` — remove text that is no longer exported from every
 * tenant's derived search indexes (umbrella bead compile-then-govern-39z.19;
 * runbook 000-docs/054-OD-RNBK §4.7).
 *
 * Exit: 0 complete (dry run: every file read) · 4 incomplete — a database was
 * busy, a step failed, a mass removal was refused, or (live) a fragment is
 * still present · 5 refused — an index file has an unexpected table layout
 * (qmd version drift) and was not touched · 2 usage error · 1 I/O failure.
 */

const SCRUB_INDEX_USAGE = `Usage: qmd-index scrub-index [--dry-run] [--json]
         [--scan-fragments-file <path>] [--index-dir <path>] [--export-dir <path>]
         [--allow-mass-removal] [--busy-timeout-ms <n>]

  --dry-run                 Read only: report per tenant and file what would be removed.
  --json                    Emit one JSON envelope.
  --scan-fragments-file <p> A 0600 file of removed text, one fragment per line. Every file
                            under the index dir is byte-scanned for them; the report names
                            files and counts, never the text. Delete the file afterwards.
  --index-dir <path>        qmd-index base (default: <TEAMKB_BASE_PATH>/qmd-index).
  --export-dir <path>       kb-export tree, the source of truth (default: TEAMKB_EXPORT_DIR
                            or <TEAMKB_BASE_PATH>/kb-export).
  --allow-mass-removal      Allow removing more than a quarter of a file's documents.
  --busy-timeout-ms <n>     SQLite busy wait per statement (default 2000).

Used by curator-cli redact (a process boundary keeps the govern core free of
this package):
  --drop-memory-id <id>     Remove this memory's rows from every index even though
                            kb-export still holds it (repeatable).
  --fragments-stdin         Read the removed text as a JSON array of strings on stdin.
  --explained-residual-ok   A fragment another memory's export still holds is reported,
                            not counted as incomplete.

Stop the brain API and MCP-using sessions first, or run in a quiet window.
Exit: 0 complete · 4 incomplete (busy / failed / residual text) · 5 unexpected
      index schema, refused · 2 usage error · 1 I/O failure.
`;

const SCRUB_INCOMPLETE_EXIT = 4;
const SCHEMA_REFUSED_EXIT = 5;

interface ScrubIndexArgs {
  dryRun: boolean;
  json: boolean;
  fragmentsFile?: string;
  fragmentsStdin: boolean;
  explainedResidualOk: boolean;
  dropMemoryIds: string[];
  indexDir?: string;
  exportDir?: string;
  allowMassRemoval: boolean;
  busyTimeoutMs?: number;
}

const VALUE_FLAGS = new Set([
  '--scan-fragments-file',
  '--index-dir',
  '--export-dir',
  '--busy-timeout-ms',
]);
const BOOL_FLAGS = new Set([
  '--dry-run',
  '--json',
  '--allow-mass-removal',
  '--fragments-stdin',
  '--explained-residual-ok',
]);
const MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseScrubArgs(
  argv: readonly string[],
): { ok: true; args: ScrubIndexArgs } | { ok: false; message: string } {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const dropMemoryIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--drop-memory-id') {
      const id = argv[i + 1];
      if (id === undefined || !MEMORY_ID.test(id)) {
        return { ok: false, message: '--drop-memory-id needs a full memory UUID' };
      }
      dropMemoryIds.push(id);
      i++;
    } else if (BOOL_FLAGS.has(flag)) {
      bools.add(flag);
    } else if (VALUE_FLAGS.has(flag)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, message: `${flag} needs a value` };
      }
      values.set(flag, value);
      i++;
    } else {
      return { ok: false, message: `unknown argument: ${flag}` };
    }
  }
  const rawTimeout = values.get('--busy-timeout-ms');
  const busyTimeoutMs = rawTimeout === undefined ? undefined : Number(rawTimeout);
  if (busyTimeoutMs !== undefined && (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0)) {
    return { ok: false, message: '--busy-timeout-ms must be a non-negative integer' };
  }
  if (values.has('--scan-fragments-file') && bools.has('--fragments-stdin')) {
    return { ok: false, message: 'give --scan-fragments-file or --fragments-stdin, not both' };
  }
  return {
    ok: true,
    args: {
      dryRun: bools.has('--dry-run'),
      json: bools.has('--json'),
      fragmentsFile: values.get('--scan-fragments-file'),
      fragmentsStdin: bools.has('--fragments-stdin'),
      explainedResidualOk: bools.has('--explained-residual-ok'),
      dropMemoryIds,
      indexDir: values.get('--index-dir'),
      exportDir: values.get('--export-dir'),
      allowMassRemoval: bools.has('--allow-mass-removal'),
      busyTimeoutMs,
    },
  };
}

/** Parse a JSON array of strings (the stdin contract). Never echoes the input. */
export function parseFragmentsJson(
  raw: string,
): { ok: true; fragments: string[] } | { ok: false; message: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'stdin is not valid JSON' };
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return { ok: false, message: 'stdin must be a JSON array of strings' };
  }
  return { ok: true, fragments: value as string[] };
}

export interface ScrubIndexDeps {
  exportDir: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  /** Reads all of stdin (default: fd 0). Injectable for tests. */
  readStdin?: () => string;
}

function loadFragments(
  args: ScrubIndexArgs,
  deps: ScrubIndexDeps,
): { ok: true; fragments: string[] | undefined } | { ok: false; message: string } {
  if (args.fragmentsFile !== undefined) {
    const read = readFragmentsFile(args.fragmentsFile);
    return read.ok ? read : { ok: false, message: `--scan-fragments-file: ${read.message}` };
  }
  if (args.fragmentsStdin) {
    const read = parseFragmentsJson((deps.readStdin ?? (() => readFileSync(0, 'utf8')))());
    return read.ok ? read : { ok: false, message: `--fragments-stdin: ${read.message}` };
  }
  return { ok: true, fragments: undefined };
}

export function runScrubIndex(argv: readonly string[], deps: ScrubIndexDeps): number {
  const parsed = parseScrubArgs(argv);
  if (!parsed.ok) {
    deps.errLog(`qmd-index scrub-index: ${parsed.message}\n\n${SCRUB_INDEX_USAGE}`);
    return 2;
  }
  const { args } = parsed;
  const loaded = loadFragments(args, deps);
  if (!loaded.ok) {
    deps.errLog(`qmd-index scrub-index: ${loaded.message}`);
    return 2;
  }
  const fragments = loaded.fragments;
  try {
    const report = scrubIndexes({
      indexDir: resolve(args.indexDir ?? getQmdIndexBasePath()),
      exportDir: resolve(args.exportDir ?? deps.exportDir),
      dryRun: args.dryRun,
      fragments,
      dropMemoryIds: args.dropMemoryIds,
      explainedResidualIsComplete: args.explainedResidualOk,
      allowMassRemoval: args.allowMassRemoval,
      busyTimeoutMs: args.busyTimeoutMs,
    });
    if (args.json) deps.log(JSON.stringify(indexScrubJson(report)));
    else deps.log(formatIndexScrub(report).trimEnd());
    if (report.schemaRefused) return SCHEMA_REFUSED_EXIT;
    return report.complete ? 0 : SCRUB_INCOMPLETE_EXIT;
  } catch (error) {
    deps.errLog(
      `qmd-index scrub-index failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
