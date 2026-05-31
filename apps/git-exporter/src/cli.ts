/**
 * exporter-cli — materialize curated memories from the store into a
 * kb-export directory of markdown files (the qmd index source).
 *
 * Used by ICO's `scripts/demo-e2e.sh` stage 5 to bridge curated memories
 * (written by the curator pipeline in stage 4) into the markdown layout
 * that `qmd collection add` indexes. The dispatch function is pure logic
 * with deps injected; production wiring lives in `main.ts`.
 *
 * Subcommands:
 *   export --db <path> --out <dir> [--tenant <id>] [--json]
 *     Run git-exporter's runExport against the store at --db, writing
 *     category-routed markdown (decisions/ curated/ guides/ archive/)
 *     under --out.
 *
 * Exit codes:
 *   0  export completed
 *   1  I/O / dispatch failure
 *   2  argument / usage error
 *
 * @module cli
 */

import {
  ExportStateRepository,
  MemoryRepository,
  type createDatabase as CreateDatabase,
} from '@qmd-team-intent-kb/store';

import { runExport } from './exporter.js';

/** Database factory — production wires `createDatabase`; tests wire
 *  `createTestDatabase` (or a shared in-memory db). */
export type DatabaseFactory = (options: { dbPath?: string }) => ReturnType<typeof CreateDatabase>;

export interface ExporterCliDeps {
  createDb: DatabaseFactory;
}

const USAGE = `Usage: exporter-cli <subcommand> [options]

Subcommands:
  export --db <path> --out <dir> [--tenant <id>] [--json]
    Write curated memories from the store as category-routed markdown.

  help | --help | -h
    Print this message.

Options for 'export':
  --db <path>     SQLite store path to read curated memories from (required).
  --out <dir>     Output directory for the kb-export markdown tree (required).
  --tenant <id>   Restrict export to one tenant (optional).
  --json          Emit a machine-readable JSON envelope to stdout.
`;

export async function dispatch(argv: string[], deps: ExporterCliDeps): Promise<number> {
  const subcommand = argv[0];
  switch (subcommand) {
    case 'export':
      return cmdExport(argv.slice(1), deps);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case undefined:
      process.stderr.write('exporter-cli: missing subcommand\n\n' + USAGE);
      return 2;
    default:
      process.stderr.write(`exporter-cli: unknown subcommand "${subcommand}"\n\n` + USAGE);
      return 2;
  }
}

interface ExportOpts {
  dbPath: string;
  outDir: string;
  tenantId?: string;
  json: boolean;
}

function parseExportArgs(
  args: string[],
): { ok: true; opts: ExportOpts } | { ok: false; message: string } {
  let dbPath: string | undefined;
  let outDir: string | undefined;
  let tenantId: string | undefined;
  let json = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    switch (arg) {
      case '--db':
        dbPath = args[i + 1];
        i += 2;
        break;
      case '--out':
        outDir = args[i + 1];
        i += 2;
        break;
      case '--tenant':
        tenantId = args[i + 1];
        i += 2;
        break;
      case '--json':
        json = true;
        i += 1;
        break;
      default:
        return { ok: false, message: `unknown flag: ${arg}` };
    }
  }

  if (dbPath === undefined || dbPath.trim() === '') {
    return { ok: false, message: 'missing required flag: --db <path>' };
  }
  if (outDir === undefined || outDir.trim() === '') {
    return { ok: false, message: 'missing required flag: --out <dir>' };
  }
  return { ok: true, opts: { dbPath, outDir, tenantId, json } };
}

async function cmdExport(args: string[], deps: ExporterCliDeps): Promise<number> {
  const parsed = parseExportArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`exporter-cli export: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const { dbPath, outDir, tenantId, json } = parsed.opts;

  const db = deps.createDb({ dbPath });
  try {
    const memoryRepo = new MemoryRepository(db);
    const exportStateRepo = new ExportStateRepository(db);

    const result = runExport(memoryRepo, exportStateRepo, {
      outputDir: outDir,
      targetId: 'demo-export',
      ...(tenantId !== undefined ? { tenantId } : {}),
    });

    if (json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          out_dir: outDir,
          tenant_id: tenantId ?? null,
          written: result.written.length,
          archived: result.archived.length,
          removed: result.removed.length,
          skipped: result.skipped.length,
          unchanged: result.unchanged,
        }) + '\n',
      );
    } else {
      process.stdout.write(
        `Exported to ${outDir}\n` +
          `Written:    ${result.written.length}\n` +
          `Archived:   ${result.archived.length}\n` +
          `Removed:    ${result.removed.length}\n` +
          `Skipped:    ${result.skipped.length}\n` +
          `Unchanged:  ${result.unchanged}\n`,
      );
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: msg, code: 'EXPORT_FAILED' }) + '\n');
    } else {
      process.stderr.write(`exporter-cli export failed: ${msg}\n`);
    }
    return 1;
  } finally {
    try {
      (db as unknown as { close?: () => void }).close?.();
    } catch {
      // non-fatal cleanup
    }
  }
}
