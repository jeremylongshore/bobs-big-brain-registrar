/**
 * `curator-cli redact` — governed redaction of one promoted memory (Epic K bead
 * K3, expanded scope; umbrella bead `compile-then-govern-39z.16`).
 *
 * Replaces the memory's content (and every candidate copy), writes hash-chained
 * `redacted` receipts, then removes the freed bytes from the database files and
 * byte-scans the files to confirm it. Then it scrubs every tenant's derived
 * search index (bead 39z.19, `index-scrub-runner.ts`) and byte-scans those
 * files with the same removed fragments. Output — text, JSON, errors — carries
 * ids, hashes, paths, counts and pattern names only, never the removed text.
 *
 * Exit: 0 redacted / would redact / already redacted · 3 refused ·
 * 4 redacted but the physical or index scrub is incomplete · 2 usage error ·
 * 1 I/O failure.
 *
 * @module redaction/redact-cli
 */

import { readFileSync } from 'node:fs';

import { scanTextForSecrets } from '@qmd-team-intent-kb/policy-engine';

import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  enableSecureDelete,
  findRowsContaining,
  scanStoreFilesForFragments,
  scrubFreedPages,
} from '@qmd-team-intent-kb/store';
import type { FragmentRowHit } from '@qmd-team-intent-kb/store';

import { closeQuietly, requireFlags, resolveMemoryId, tokenizeFlags } from '../cli-args.js';
import type { CliDatabase, CliDbDeps, Parsed } from '../cli-args.js';
import { defaultIndexDirs, runIndexScrub } from './index-scrub-runner.js';
import type { IndexScrubOutcome } from './index-scrub-runner.js';
import { redactMemory } from './redact-memory.js';
import type { RedactMemoryResult, RedactionMode, RedactionSpan } from './redact-memory.js';

const REDACT_USAGE = `Usage: curator-cli redact --db <path> --tenant <id> --memory-id <id|prefix>
         --actor <id> --reason <text>
         (--replacement-text <text> | --replacement-file <path> | --lines <ranges> | --scan)
         [--replacement-title <text>] [--show-title] [--dry-run] [--json] [--skip-scrub]
         [--index-dir <path>] [--export-dir <path>] [--skip-index-scrub]

  --db <path>               SQLite path (required — refuses an implicit in-memory store).
  --tenant <id>             Tenant scope (required).
  --memory-id <id>          The memory: a full id or a unique prefix (>= 8 hex chars).
  --actor <id>              Human actor recorded on the receipt (required).
  --reason <text>           Reason recorded verbatim on the receipt (required).
                            Do not quote the secret in it.
  --replacement-text <text> Replace the WHOLE content with this text.
  --replacement-file <path> Replace the WHOLE content with this file's text.
  --lines <ranges>          Replace these 1-based content lines with [REDACTED],
                            e.g. 12,20-22.
  --scan                    Replace what the deterministic secret scan recognizes
                            with [REDACTED:<pattern>]. Refused when the scan finds
                            nothing, or when anything still fires afterwards.
  --replacement-title <text> Also replace the title (when the title holds the secret).
  --show-title              Print the memory's current title, to confirm the target.
                            Off by default: a title can itself hold the secret. It is
                            withheld when the scan fires on it or it is being replaced.
  --dry-run                 Open the store READ-ONLY and report what would change.
  --json                    Emit a JSON envelope in place of the summary.
  --skip-scrub              Do not rebuild FTS / truncate the WAL / VACUUM afterwards.
                            The old bytes then remain in the files until you do.
  --index-dir <path>        Derived search indexes, one subdirectory per tenant
                            (default: qmd-index beside the --db file).
  --export-dir <path>       kb-export tree (default: kb-export beside the --db file).
  --skip-index-scrub        Do not scrub the derived indexes (use when you are about to
                            delete and rebuild them anyway). They keep the old text.

Every mode re-scans the result and refuses if a secret pattern still fires.
Output never contains the removed text.

Every tenant's index under --index-dir is scrubbed: the memory's rows are
removed from the qmd cache, native FTS5 and dense sidecar until the exporter
rewrites its file, then every index file is byte-scanned for the removed text.

Exit: 0 done · 3 refused · 4 redacted but the physical or index scrub is
      incomplete · 2 usage error · 1 I/O failure.
`;

const VALUE_FLAGS = new Set([
  '--db',
  '--tenant',
  '--memory-id',
  '--actor',
  '--reason',
  '--replacement-text',
  '--replacement-file',
  '--lines',
  '--replacement-title',
  '--index-dir',
  '--export-dir',
]);
const BOOL_FLAGS = new Set([
  '--scan',
  '--dry-run',
  '--json',
  '--skip-scrub',
  '--show-title',
  '--skip-index-scrub',
]);

const REFUSED_EXIT = 3;
const SCRUB_INCOMPLETE_EXIT = 4;

/** What the operator must still do after a redaction. Printed on every live run. */
const REDACTION_NEXT_STEPS: readonly string[] = [
  'Rotate the credential. Redaction removes the text from this store; it does not un-leak it.',
  'Run the exporter in reconcile mode so the exported Markdown file is rewritten. Until then the memory is missing from search, and a reindex would re-add the old text.',
  'Reindex (qmd and the dense index) for every tenant, then run `qmd-index scrub-index` (with --scan-fragments-file if you kept the removed text in a 0600 file) to confirm.',
  'Take a fresh backup, then let older backups age out: every existing backup (local, VPS, R2, borg, B2) still holds the old text.',
];

type ModeSource =
  | { kind: 'replacement-text'; text: string }
  | { kind: 'replacement-file'; path: string }
  | { kind: 'lines'; ranges: string }
  | { kind: 'scan' };

interface RedactOpts {
  dbPath: string;
  tenantId: string;
  memoryId: string;
  actor: string;
  reason: string;
  source: ModeSource;
  replacementTitle?: string;
  dryRun: boolean;
  json: boolean;
  skipScrub: boolean;
  showTitle: boolean;
  skipIndexScrub: boolean;
  indexDir: string;
  exportDir: string;
}

function parseModeSource(
  values: ReadonlyMap<string, string>,
  bools: ReadonlySet<string>,
): Parsed<{ source: ModeSource }> {
  const sources: ModeSource[] = [];
  const text = values.get('--replacement-text');
  const file = values.get('--replacement-file');
  const lines = values.get('--lines');
  if (text !== undefined) sources.push({ kind: 'replacement-text', text });
  if (file !== undefined) sources.push({ kind: 'replacement-file', path: file });
  if (lines !== undefined) sources.push({ kind: 'lines', ranges: lines });
  if (bools.has('--scan')) sources.push({ kind: 'scan' });
  if (sources.length !== 1) {
    return {
      ok: false,
      message: 'give exactly one of --replacement-text, --replacement-file, --lines or --scan',
    };
  }
  return { ok: true, source: sources[0]! };
}

function parseArgs(args: readonly string[]): Parsed<{ opts: RedactOpts }> {
  const tokens = tokenizeFlags(args, VALUE_FLAGS, BOOL_FLAGS);
  if (!tokens.ok) return tokens;
  const { values, bools } = tokens;
  const required = requireFlags(values, ['--db', '--tenant', '--memory-id', '--actor', '--reason']);
  if (!required.ok) return required;
  const mode = parseModeSource(values, bools);
  if (!mode.ok) return mode;
  const dirs = defaultIndexDirs(values.get('--db')!);
  return {
    ok: true,
    opts: {
      dbPath: values.get('--db')!,
      tenantId: values.get('--tenant')!,
      memoryId: values.get('--memory-id')!,
      actor: values.get('--actor')!,
      reason: values.get('--reason')!,
      source: mode.source,
      replacementTitle: values.get('--replacement-title'),
      dryRun: bools.has('--dry-run'),
      json: bools.has('--json'),
      skipScrub: bools.has('--skip-scrub'),
      showTitle: bools.has('--show-title'),
      skipIndexScrub: bools.has('--skip-index-scrub'),
      indexDir: values.get('--index-dir') ?? dirs.indexDir,
      exportDir: values.get('--export-dir') ?? dirs.exportDir,
    },
  };
}

/**
 * Turn `12,20-22` (1-based, inclusive content lines) into character spans, one
 * per named line, each covering the line's text without its newline.
 */
export function lineRangesToSpans(
  content: string,
  ranges: string,
): Parsed<{ spans: RedactionSpan[] }> {
  const wanted = new Set<number>();
  for (const part of ranges.split(',')) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (match === null) return { ok: false, message: `--lines: "${part}" is not N or N-M` };
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (first < 1 || last < first) {
      return { ok: false, message: `--lines: "${part}" is not a valid 1-based range` };
    }
    if (last - first > 100_000) return { ok: false, message: `--lines: "${part}" is too large` };
    for (let n = first; n <= last; n++) wanted.add(n);
  }
  const lines = content.split('\n');
  const spans: RedactionSpan[] = [];
  let offset = 0;
  for (let n = 1; n <= lines.length; n++) {
    const length = lines[n - 1]!.length;
    if (wanted.has(n)) {
      if (length === 0) return { ok: false, message: `--lines: line ${n} is empty` };
      spans.push({ start: offset, end: offset + length });
    }
    offset += length + 1;
  }
  const beyond = [...wanted].filter((n) => n > lines.length);
  if (beyond.length > 0) {
    return {
      ok: false,
      message: `--lines: line ${Math.min(...beyond)} is past the end of the content (${lines.length} lines)`,
    };
  }
  return { ok: true, spans };
}

/** Build the service's redaction mode from the CLI's mode source. */
function buildMode(source: ModeSource, content: string | null): Parsed<{ mode: RedactionMode }> {
  switch (source.kind) {
    case 'scan':
      return { ok: true, mode: { kind: 'scan' } };
    case 'replacement-text':
      return { ok: true, mode: { kind: 'replacement', content: source.text } };
    case 'replacement-file':
      try {
        return {
          ok: true,
          mode: { kind: 'replacement', content: readFileSync(source.path, 'utf8') },
        };
      } catch (e) {
        return {
          ok: false,
          message: `cannot read --replacement-file ${source.path}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    case 'lines': {
      // An unknown memory is the service's refusal to report, not a usage error.
      if (content === null) return { ok: true, mode: { kind: 'spans', spans: [] } };
      const spans = lineRangesToSpans(content, source.ranges);
      return spans.ok ? { ok: true, mode: { kind: 'spans', spans: spans.spans } } : spans;
    }
  }
}

const TITLE_WITHHELD = '(withheld)';

/**
 * The title to show for target confirmation, or null when not asked for. A
 * title the secret scan fires on, or one this run replaces, is withheld.
 */
function displayTitle(opts: RedactOpts, title: string | null): string | null {
  if (!opts.showTitle || title === null) return null;
  if (opts.replacementTitle !== undefined || scanTextForSecrets(title).length > 0) {
    return TITLE_WITHHELD;
  }
  return title;
}

/** The physical-scrub section of the report. Ids and counts only. */
interface ScrubSummary {
  secureDelete: boolean;
  ftsRebuilt: boolean;
  walTruncated: boolean;
  vacuumed: boolean;
  errors: string[];
  filesScanned: string[];
  fragmentsChecked: number;
  /** Removed fragments whose bytes are still in a store file. */
  residualFragments: number;
  /** Of those, how many are NOT explained by a current row still holding that text. */
  unexplainedResidualFragments: number;
  /** Current rows that still hold removed text — other rows to look at. */
  rowsStillContainingRemovedText: FragmentRowHit[];
  complete: boolean;
}

/** Remove the freed bytes, then byte-scan the store files for the removed text. */
function scrubAndVerify(
  db: CliDatabase,
  dbPath: string,
  secureDelete: boolean,
  fragments: readonly string[],
): ScrubSummary {
  const scrub = scrubFreedPages(db);
  const scan = scanStoreFilesForFragments(dbPath, fragments);
  const rows = new Map<string, FragmentRowHit>();
  let unexplained = 0;
  for (const index of scan.residualFragmentIndexes) {
    const hits = findRowsContaining(db, fragments[index]!);
    if (hits.length === 0) unexplained += 1;
    for (const hit of hits) rows.set(`${hit.table}:${hit.id}`, hit);
  }
  return {
    secureDelete,
    ftsRebuilt: scrub.ftsRebuilt,
    walTruncated: scrub.walTruncated,
    vacuumed: scrub.vacuumed,
    errors: scrub.errors,
    filesScanned: scan.filesScanned,
    fragmentsChecked: scan.fragmentCount,
    residualFragments: scan.residualFragmentIndexes.length,
    unexplainedResidualFragments: unexplained,
    rowsStillContainingRemovedText: [...rows.values()],
    complete: scrub.errors.length === 0 && unexplained === 0,
  };
}

function scrubJson(scrub: ScrubSummary | null): Record<string, unknown> | null {
  if (scrub === null) return null;
  return {
    complete: scrub.complete,
    secure_delete: scrub.secureDelete,
    fts_rebuilt: scrub.ftsRebuilt,
    wal_truncated: scrub.walTruncated,
    vacuumed: scrub.vacuumed,
    errors: scrub.errors,
    files_scanned: scrub.filesScanned,
    fragments_checked: scrub.fragmentsChecked,
    residual_fragments: scrub.residualFragments,
    unexplained_residual_fragments: scrub.unexplainedResidualFragments,
    rows_still_containing_removed_text: scrub.rowsStillContainingRemovedText,
  };
}

function indexScrubJson(outcome: IndexScrubOutcome | null): Record<string, unknown> | null {
  if (outcome === null) return null;
  return {
    ran: outcome.ran,
    complete: outcome.complete,
    index_dir: outcome.indexDir,
    export_dir: outcome.exportDir,
    note: outcome.note,
    exit_code: outcome.exitCode,
    report: outcome.report,
  };
}

function emitJson(
  opts: RedactOpts,
  result: RedactMemoryResult,
  scrub: ScrubSummary | null,
  indexScrub: IndexScrubOutcome | null,
  title: string | null,
): void {
  const body = result.ok
    ? {
        ok: true,
        dry_run: opts.dryRun,
        status: result.status,
        memory_id: result.memoryId,
        tenant_id: opts.tenantId,
        ...(title !== null ? { title } : {}),
        mode: result.mode,
        old_content_hash: result.oldContentHash,
        new_content_hash: result.newContentHash,
        pattern_names: result.patternNames,
        pattern_lines: result.patternLines,
        title_changed: result.titleChanged,
        candidate_ids: result.candidateIds,
        audit_event_ids: result.auditEventIds,
        physical_scrub: scrubJson(scrub),
        index_scrub: indexScrubJson(indexScrub),
        next_steps: opts.dryRun ? [] : REDACTION_NEXT_STEPS,
      }
    : {
        ok: false,
        dry_run: opts.dryRun,
        status: 'refused',
        memory_id: result.memoryId,
        tenant_id: opts.tenantId,
        code: result.code,
        error: result.error,
      };
  process.stdout.write(JSON.stringify(body) + '\n');
}

function emitScrubText(scrub: ScrubSummary): void {
  process.stdout.write(
    `Physical scrub: ${scrub.complete ? 'complete' : 'INCOMPLETE'}\n` +
      `  secure_delete=${scrub.secureDelete} fts_rebuilt=${scrub.ftsRebuilt} ` +
      `wal_truncated=${scrub.walTruncated} vacuumed=${scrub.vacuumed}\n` +
      `  byte scan: ${scrub.fragmentsChecked} removed fragment(s) checked in ` +
      `${scrub.filesScanned.length} file(s); ${scrub.residualFragments} still present, ` +
      `${scrub.unexplainedResidualFragments} unexplained\n`,
  );
  for (const error of scrub.errors) process.stdout.write(`  scrub step failed: ${error}\n`);
  if (scrub.rowsStillContainingRemovedText.length > 0) {
    process.stdout.write('  Removed text is still held by these current rows (review them):\n');
    for (const row of scrub.rowsStillContainingRemovedText) {
      process.stdout.write(`    ${row.table} ${row.id}\n`);
    }
  }
  if (!scrub.complete) {
    process.stdout.write(
      '  The redaction is committed and receipted, but old bytes may remain in the store files.\n' +
        '  Stop other processes using this store and re-run the same command to retry the scrub.\n',
    );
  }
}

/** Pull the per-file lines out of the child's JSON envelope for the text report. */
function indexScrubFileLines(report: Record<string, unknown>): string[] {
  const tenants = Array.isArray(report['tenants']) ? report['tenants'] : [];
  const lines: string[] = [];
  for (const tenant of tenants as Array<{ tenant?: unknown; files?: unknown }>) {
    const files = Array.isArray(tenant.files) ? tenant.files : [];
    for (const file of files as Array<{ file?: unknown; status?: unknown; errors?: unknown }>) {
      lines.push(`    ${String(file.file)} [${String(file.status)}]`);
      const errors = Array.isArray(file.errors) ? file.errors : [];
      for (const error of errors) lines.push(`      ${String(error)}`);
    }
  }
  const scan = report['fragment_scan'] as Record<string, unknown> | null | undefined;
  if (scan !== null && scan !== undefined) {
    lines.push(
      `    byte scan: ${String(scan['fragments_checked'])} fragment(s) in ` +
        `${String(scan['files_scanned'])} file(s); ${String(scan['residual_fragments'])} still ` +
        `present, ${String(scan['unexplained_residual_fragments'])} unexplained`,
    );
  }
  return lines;
}

function emitIndexScrubText(outcome: IndexScrubOutcome): void {
  const verdict = outcome.complete ? 'complete for this memory' : 'INCOMPLETE';
  const lines = [`Index scrub: ${verdict}${outcome.ran ? '' : ' (not run)'}`];
  if (outcome.ran && outcome.complete) {
    // Redact-time scope: this memory's rows are gone and every index file was
    // byte-scanned, but a fragment another memory still exports is reported,
    // not failed, and the export of THIS memory is not reconciled yet.
    lines.push(
      '  Confirm after export --reconcile and reindex with `qmd-index scrub-index`',
      '  (add --scan-fragments-file to byte-check the removed text).',
    );
  }
  lines.push(`  index dir: ${outcome.indexDir}`);
  if (outcome.note !== null) lines.push(`  ${outcome.note}`);
  if (outcome.report !== null) lines.push(...indexScrubFileLines(outcome.report));
  if (!outcome.complete) {
    lines.push(
      '  The redaction is committed and receipted, but an index may still hold the old text.',
      '  Stop the brain API and MCP-using sessions, then run `qmd-index scrub-index`.',
    );
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function emitText(
  opts: RedactOpts,
  result: RedactMemoryResult,
  scrub: ScrubSummary | null,
  indexScrub: IndexScrubOutcome | null,
  title: string | null,
): void {
  if (!result.ok) {
    process.stdout.write(`redact refused [${result.code}]: ${result.error}\n`);
    return;
  }
  const headline =
    result.status === 'would_redact'
      ? 'redact (dry-run — nothing written): would redact'
      : result.status === 'unchanged'
        ? 'redact: content already equals the replacement — nothing written'
        : 'redact: redacted';
  process.stdout.write(
    `${headline}\n` +
      `Memory:        ${result.memoryId}\n` +
      (title !== null ? `Title:         ${title}\n` : '') +
      `Mode:          ${result.mode}\n` +
      `Old hash:      ${result.oldContentHash}\n` +
      `New hash:      ${result.newContentHash}\n` +
      `Patterns:      ${result.patternNames.length > 0 ? result.patternNames.join(', ') : '(none recognized by the scan)'}\n` +
      `Title changed: ${result.titleChanged}\n` +
      `Candidate copies: ${result.candidateIds.length}\n`,
  );
  for (const [name, lines] of Object.entries(result.patternLines)) {
    process.stdout.write(`  ${name}: content line(s) ${lines.join(', ')}\n`);
  }
  for (const id of result.auditEventIds) process.stdout.write(`  receipt=${id}\n`);
  if (scrub !== null) emitScrubText(scrub);
  if (indexScrub !== null) emitIndexScrubText(indexScrub);
  if (!opts.dryRun) {
    process.stdout.write('\nStill to do:\n');
    REDACTION_NEXT_STEPS.forEach((step, i) => process.stdout.write(`  ${i + 1}. ${step}\n`));
  }
}

export async function cmdRedact(args: string[], deps: CliDbDeps): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`curator-cli redact: ${parsed.message}\n\n${REDACT_USAGE}`);
    return 2;
  }
  const { opts } = parsed;

  let db: CliDatabase;
  try {
    // Dry-run opens READ-ONLY: the preview structurally cannot write.
    db = deps.createDb({ dbPath: opts.dbPath, readonly: opts.dryRun });
  } catch (err) {
    process.stderr.write(`redact failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  try {
    const resolved = resolveMemoryId(db, opts.tenantId, opts.memoryId);
    if (!resolved.ok) {
      process.stderr.write(`curator-cli redact: ${resolved.message}\n`);
      return 2;
    }
    const memoryRepo = new MemoryRepository(db);
    // A memory in another tenant is treated as absent from here on, so nothing
    // about it (its line count, its title) can reach the output.
    const found = memoryRepo.findById(resolved.id);
    const existing = found !== null && found.tenantId === opts.tenantId ? found : null;
    const mode = buildMode(opts.source, existing === null ? null : existing.content);
    if (!mode.ok) {
      process.stderr.write(`curator-cli redact: ${mode.message}\n`);
      return 2;
    }

    // Before the UPDATE, so the cells it frees are zeroed rather than left behind.
    const secureDelete = opts.dryRun ? false : enableSecureDelete(db);
    const { result, removedFragments } = redactMemory(
      {
        memoryId: resolved.id,
        tenantId: opts.tenantId,
        actor: opts.actor,
        reason: opts.reason,
        mode: mode.mode,
        replacementTitle: opts.replacementTitle,
        dryRun: opts.dryRun,
      },
      {
        memoryRepo,
        candidateRepo: new CandidateRepository(db),
        auditRepo: new AuditRepository(db),
      },
    );

    const runScrub = result.ok && !opts.dryRun && !opts.skipScrub;
    const scrub = runScrub ? scrubAndVerify(db, opts.dbPath, secureDelete, removedFragments) : null;
    // After the DB scrub, with the same in-memory fragments. An `unchanged`
    // re-run has no fragments to scan for but still scrubs (that is the retry).
    const runIndex = result.ok && !opts.dryRun && !opts.skipIndexScrub;
    const indexScrub = runIndex
      ? runIndexScrub({
          indexDir: opts.indexDir,
          exportDir: opts.exportDir,
          memoryId: result.memoryId,
          fragments: removedFragments,
        })
      : null;

    const title = displayTitle(opts, existing === null ? null : existing.title);
    if (opts.json) emitJson(opts, result, scrub, indexScrub, title);
    else emitText(opts, result, scrub, indexScrub, title);

    if (!result.ok) return REFUSED_EXIT;
    const dbIncomplete = scrub !== null && !scrub.complete;
    const indexIncomplete = indexScrub !== null && !indexScrub.complete;
    return dbIncomplete || indexIncomplete ? SCRUB_INCOMPLETE_EXIT : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: msg, code: 'REDACT_FAILED' }) + '\n');
    } else {
      process.stderr.write(`redact failed: ${msg}\n`);
    }
    return 1;
  } finally {
    closeQuietly(db);
  }
}
