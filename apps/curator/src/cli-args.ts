/**
 * Small argument helpers shared by the governed-write subcommands
 * (`narrow-audience`, `redact`). Kept out of `cli.ts` so each subcommand lives
 * in its own module.
 *
 * @module cli-args
 */

import { readFileSync } from 'node:fs';

import type { createDatabase as CreateDatabase } from '@qmd-team-intent-kb/store';

export type CliDatabase = ReturnType<typeof CreateDatabase>;

/** The database factory a subcommand needs (structurally the CLI's own deps). */
export interface CliDbDeps {
  createDb: (options: { dbPath?: string; readonly?: boolean }) => CliDatabase;
}

export type Parsed<T> = ({ ok: true } & T) | { ok: false; message: string };

/** Generic UUID shape (curated memory ids are content-derived UUIDv5). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A leading slice of a UUID: at least the first 8 hex characters. */
const UUID_PREFIX_PATTERN = /^[0-9a-f]{8}[0-9a-f-]*$/i;

/**
 * Split argv into value flags (`--flag value`) and boolean flags. An unknown
 * flag, or a value flag with no value, is a usage error.
 */
export function tokenizeFlags(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
  boolFlags: ReadonlySet<string>,
): Parsed<{ values: Map<string, string>; bools: Set<string> }> {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (valueFlags.has(arg)) {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: `${arg} requires a value` };
      values.set(arg, value);
      i += 2;
    } else if (boolFlags.has(arg)) {
      bools.add(arg);
      i += 1;
    } else {
      return { ok: false, message: `unknown flag: ${arg}` };
    }
  }
  return { ok: true, values, bools };
}

/** Require each named flag to be present and non-blank. */
export function requireFlags(
  values: ReadonlyMap<string, string>,
  names: readonly string[],
): Parsed<object> {
  for (const name of names) {
    const value = values.get(name);
    if (value === undefined || value.trim() === '') {
      return { ok: false, message: `missing required flag: ${name}` };
    }
  }
  return { ok: true };
}

/**
 * Read an ids file: one memory UUID per line, `#` comments and blank lines
 * allowed. A malformed line is a hard error — dropping it silently would change
 * the scope of a governed write.
 */
export function readIdsFile(path: string): Parsed<{ ids: string[] }> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return {
      ok: false,
      message: `cannot read --ids-file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const ids: string[] = [];
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!UUID_PATTERN.test(line)) {
      return { ok: false, message: `--ids-file ${path} line ${n + 1} is not a UUID` };
    }
    ids.push(line.toLowerCase());
  }
  if (ids.length === 0) return { ok: false, message: `--ids-file ${path} contains no memory ids` };
  return { ok: true, ids: [...new Set(ids)] };
}

/**
 * Resolve `--memory-id` to one full memory id inside the tenant. Accepts a full
 * UUID (returned as given — existence is the service's check) or a unique
 * leading prefix of at least 8 hex characters. An ambiguous or unmatched prefix
 * is an error: a governed write never guesses its target.
 */
export function resolveMemoryId(
  db: CliDatabase,
  tenantId: string,
  idOrPrefix: string,
): Parsed<{ id: string }> {
  const wanted = idOrPrefix.trim().toLowerCase();
  if (UUID_PATTERN.test(wanted)) return { ok: true, id: wanted };
  if (!UUID_PREFIX_PATTERN.test(wanted)) {
    return {
      ok: false,
      message: `--memory-id "${idOrPrefix}" is neither a UUID nor a prefix of at least 8 hex characters`,
    };
  }
  const rows = db
    .prepare(
      `SELECT id FROM curated_memories
       WHERE tenant_id = ? AND substr(lower(id), 1, ?) = ?
       LIMIT 2`,
    )
    .all(tenantId, wanted.length, wanted) as Array<{ id: string }>;
  if (rows.length === 0) {
    return { ok: false, message: `no memory in tenant ${tenantId} has an id starting ${wanted}` };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      message: `id prefix ${wanted} matches more than one memory in tenant ${tenantId}; give more characters`,
    };
  }
  return { ok: true, id: rows[0]!.id };
}

/** Close a database handle, ignoring a failure to do so. */
export function closeQuietly(db: CliDatabase): void {
  try {
    db.close();
  } catch {
    // non-fatal
  }
}
