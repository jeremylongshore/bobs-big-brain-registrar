/**
 * `curator-cli narrow-audience` — governed audience narrowing of promoted
 * memories (Epic K bead K3).
 *
 * One memory (`--memory-id`, full id or unique prefix) or many (`--ids-file`).
 * Each memory is narrowed in ITS OWN transaction with ITS OWN hash-chained
 * `audience_narrowed` receipt. Widening, an unknown tier, an unknown id and a
 * missing reason are refusals, reported per memory. `--dry-run` opens the store
 * READ-ONLY, so the preview structurally cannot write.
 *
 * Exit: 0 every target narrowed (or would be) · 3 at least one refusal ·
 * 2 usage error · 1 I/O failure.
 *
 * @module audience/narrow-cli
 */

import { recommendAudience } from '@qmd-team-intent-kb/policy-engine';
import { AuditRepository, MemoryRepository } from '@qmd-team-intent-kb/store';

import {
  closeQuietly,
  readIdsFile,
  requireFlags,
  resolveMemoryId,
  tokenizeFlags,
} from '../cli-args.js';
import type { CliDatabase, CliDbDeps, Parsed } from '../cli-args.js';
import { narrowAudience } from './narrow-audience.js';
import type { NarrowAudienceResult } from './narrow-audience.js';

const NARROW_AUDIENCE_USAGE = `Usage: curator-cli narrow-audience --db <path> --tenant <id> --to <admins|owner>
         --actor <id> --reason <text> (--memory-id <id|prefix> | --ids-file <path>)
         [--dry-run] [--json]

  --db <path>          SQLite path (required — refuses an implicit in-memory store).
  --tenant <id>        Tenant scope (required). A memory in another tenant is not found.
  --to <tier>          Target audience. Narrowing only: tenant -> admins -> owner.
                       A wider or equal tier is refused.
  --actor <id>         Human actor recorded on every receipt (required).
  --reason <text>      Reason recorded verbatim on every receipt (required).
  --memory-id <id>     One memory: a full id or a unique prefix (>= 8 hex chars).
  --ids-file <path>    Many memories: one UUID per line ('#' comments allowed).
  --dry-run            Open the store READ-ONLY and report what would change.
  --json               Emit a JSON envelope in place of the summary.

Exit: 0 all narrowed · 3 at least one refusal · 2 usage error · 1 I/O failure.
`;

const VALUE_FLAGS = new Set([
  '--db',
  '--tenant',
  '--to',
  '--actor',
  '--reason',
  '--memory-id',
  '--ids-file',
]);
const BOOL_FLAGS = new Set(['--dry-run', '--json']);

/** Exit code for "ran, and at least one target was refused". */
const REFUSED_EXIT = 3;

interface NarrowOpts {
  dbPath: string;
  tenantId: string;
  to: string;
  actor: string;
  reason: string;
  memoryId?: string;
  idsFile?: string;
  dryRun: boolean;
  json: boolean;
}

function parseArgs(args: readonly string[]): Parsed<{ opts: NarrowOpts }> {
  const tokens = tokenizeFlags(args, VALUE_FLAGS, BOOL_FLAGS);
  if (!tokens.ok) return tokens;
  const { values, bools } = tokens;
  const required = requireFlags(values, ['--db', '--tenant', '--to', '--actor', '--reason']);
  if (!required.ok) return required;
  const memoryId = values.get('--memory-id');
  const idsFile = values.get('--ids-file');
  if ((memoryId === undefined) === (idsFile === undefined)) {
    return { ok: false, message: 'give exactly one of --memory-id or --ids-file' };
  }
  return {
    ok: true,
    opts: {
      dbPath: values.get('--db')!,
      tenantId: values.get('--tenant')!,
      to: values.get('--to')!,
      actor: values.get('--actor')!,
      reason: values.get('--reason')!,
      memoryId,
      idsFile,
      dryRun: bools.has('--dry-run'),
      json: bools.has('--json'),
    },
  };
}

/** Resolve the target ids from `--memory-id` or `--ids-file`. */
function resolveTargets(db: CliDatabase, opts: NarrowOpts): Parsed<{ ids: string[] }> {
  if (opts.idsFile !== undefined) return readIdsFile(opts.idsFile);
  const resolved = resolveMemoryId(db, opts.tenantId, opts.memoryId!);
  return resolved.ok ? { ok: true, ids: [resolved.id] } : resolved;
}

/** One reported target: the service outcome plus what the K3 rule recommends. */
interface NarrowReportRow {
  outcome: NarrowAudienceResult;
  /** Audience the `audience_narrowing` rule recommends for the content, if the memory exists. */
  recommended: string | null;
}

function emit(opts: NarrowOpts, rows: readonly NarrowReportRow[]): void {
  const applied = rows.filter((r) => r.outcome.ok);
  const refused = rows.filter((r) => !r.outcome.ok);
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        ok: refused.length === 0,
        dry_run: opts.dryRun,
        tenant_id: opts.tenantId,
        to: opts.to,
        narrowed: applied.length,
        refused: refused.length,
        results: rows.map(({ outcome, recommended }) =>
          outcome.ok
            ? {
                memory_id: outcome.memoryId,
                status: opts.dryRun ? 'would_narrow' : 'narrowed',
                from: outcome.from,
                to: outcome.to,
                audit_event_id: outcome.auditEventId,
                rule_recommended_audience: recommended,
              }
            : {
                memory_id: outcome.memoryId,
                status: 'refused',
                code: outcome.code,
                error: outcome.error,
                rule_recommended_audience: recommended,
              },
        ),
      }) + '\n',
    );
    return;
  }
  process.stdout.write(
    `narrow-audience ${opts.dryRun ? '(dry-run — nothing written) ' : ''}complete\n` +
      `Tenant:  ${opts.tenantId}\n` +
      `Target:  ${opts.to}\n` +
      `${opts.dryRun ? 'Would narrow' : 'Narrowed'}: ${applied.length}\n` +
      `Refused: ${refused.length}\n`,
  );
  for (const { outcome, recommended } of rows) {
    const hint = recommended === null ? '' : `  (rule recommends: ${recommended})`;
    if (outcome.ok) {
      const receipt = outcome.auditEventId === null ? '' : `  receipt=${outcome.auditEventId}`;
      process.stdout.write(
        `  ${outcome.memoryId}  ${outcome.from} -> ${outcome.to}${receipt}${hint}\n`,
      );
    } else {
      process.stdout.write(
        `  refused ${outcome.memoryId} [${outcome.code}]: ${outcome.error}${hint}\n`,
      );
    }
  }
  if (!opts.dryRun && applied.length > 0) {
    process.stdout.write(
      '\nNext: run the exporter in reconcile mode so a narrowed memory leaves the shared\n' +
        'export tree, then reindex. Until then the old file is still in the tree and index.\n',
    );
  }
}

export async function cmdNarrowAudience(args: string[], deps: CliDbDeps): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    process.stderr.write(
      `curator-cli narrow-audience: ${parsed.message}\n\n${NARROW_AUDIENCE_USAGE}`,
    );
    return 2;
  }
  const { opts } = parsed;

  let db: CliDatabase;
  try {
    // Dry-run opens READ-ONLY: the preview structurally cannot write.
    db = deps.createDb({ dbPath: opts.dbPath, readonly: opts.dryRun });
  } catch (err) {
    process.stderr.write(
      `narrow-audience failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  try {
    const targets = resolveTargets(db, opts);
    if (!targets.ok) {
      process.stderr.write(`curator-cli narrow-audience: ${targets.message}\n`);
      return 2;
    }
    const memoryRepo = new MemoryRepository(db);
    const auditRepo = new AuditRepository(db);
    const rows: NarrowReportRow[] = targets.ids.map((memoryId) => {
      // What the K3 rule recommends for this content — reported, never applied.
      const before = memoryRepo.findById(memoryId);
      const recommended =
        before !== null && before.tenantId === opts.tenantId
          ? recommendAudience(before.content, before.metadata.audience).recommended
          : null;
      const outcome = narrowAudience(
        {
          memoryId,
          tenantId: opts.tenantId,
          to: opts.to,
          actor: opts.actor,
          reason: opts.reason,
          dryRun: opts.dryRun,
        },
        memoryRepo,
        auditRepo,
      );
      return { outcome, recommended };
    });
    emit(opts, rows);
    return rows.every((r) => r.outcome.ok) ? 0 : REFUSED_EXIT;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: msg, code: 'NARROW_AUDIENCE_FAILED' }) + '\n',
      );
    } else {
      process.stderr.write(`narrow-audience failed: ${msg}\n`);
    }
    return 1;
  } finally {
    closeQuietly(db);
  }
}
