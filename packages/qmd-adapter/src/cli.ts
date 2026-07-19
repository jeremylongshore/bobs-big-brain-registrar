#!/usr/bin/env node
/**
 * CLI: reindex + search-health canary for a tenant's governed qmd index.
 *
 *   node dist/cli.js reindex            # rebuild the derived qmd-index from kb-export (idempotent)
 *   node dist/cli.js canary             # run known-positive controls; exit 1 if any returns 0 hits
 *   node dist/cli.js canary --heal      # canary; on failure, reindex once and re-check
 *   node dist/cli.js canary --max-staleness-seconds 86400
 *                                       # ALSO fail if a promotion has waited longer than the
 *                                       # threshold to become searchable (D2 staleness gate;
 *                                       # measured from TEAMKB_DB_PATH / <base>/teamkb.db when
 *                                       # present — no brain DB → gate reports "unmeasured" and
 *                                       # passes, so the CI fixture canary stays green)
 *
 * Tenant + paths resolve from the same env the rest of INTKB uses:
 *   TEAMKB_TENANT_ID  (default: intent-solutions — the live brain's tenant)
 *   TEAMKB_BASE_PATH  (default: ~/.teamkb)         → exportDir = <base>/kb-export
 *   TEAMKB_EXPORT_DIR (overrides exportDir)
 *
 * Why (bead compile-then-govern-e06.13 / risk register R11 / umbrella #27):
 * `brain_search` degrades to an EMPTY result on a missing/misrouted index
 * instead of erroring, so a broken index is invisible at the tool surface —
 * exactly the "SEARCH DEGRADED, 0 hits on known-positive controls" incident.
 * `canary` turns that silent failure into a non-zero exit code so CI / the
 * nightly / an operator sees it; `reindex` is the repeatable, idempotent
 * rebuild of the derived index (never touches teamkb.db or brain/raw).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { getTeamKbBasePath } from '@qmd-team-intent-kb/common';
import { IndexStateRepository } from '@qmd-team-intent-kb/store';
import { QmdAdapter } from './adapter.js';
import type { StalenessProbe } from './types.js';
import { reindex } from './reindex/reindex.js';
import { runSearchCanary, formatCanaryReport } from './canary/search-canary.js';

/** Default tenant — the live brain's tenant (matches apps/api and the nightly MCP config). */
export const DEFAULT_CLI_TENANT = 'intent-solutions';

/** Resolve tenant + export dir from env, mirroring the MCP/API resolvers. */
export function resolveCliContext(env: NodeJS.ProcessEnv = process.env): {
  tenantId: string;
  exportDir: string;
} {
  const tenantId = env['TEAMKB_TENANT_ID']?.trim() || DEFAULT_CLI_TENANT;
  // Trim + non-empty guard: a blank/whitespace-only TEAMKB_EXPORT_DIR is still
  // truthy, and `resolve('')` collapses to process.cwd() — reading/writing the
  // qmd collections in the wrong directory. Fall back to the default instead.
  const rawExportDir = env['TEAMKB_EXPORT_DIR']?.trim();
  const exportDir = rawExportDir ? resolve(rawExportDir) : join(getTeamKbBasePath(), 'kb-export');
  return { tenantId, exportDir };
}

/** Injectable seams so tests can drive `run` without a real qmd binary. */
export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  errLog?: (msg: string) => void;
  /** Adapter factory — defaults to the real `QmdAdapter`; tests inject a fake. */
  makeAdapter?: (tenantId: string, exportDir: string) => QmdAdapter;
  /**
   * Staleness-probe factory for the canary's D2 gate — defaults to
   * {@link makeStoreStalenessProbe} (reads the live brain DB read-only); tests
   * inject a fake.
   */
  makeStalenessProbe?: (tenantId: string, env: NodeJS.ProcessEnv) => StalenessProbe;
}

/**
 * Build a staleness probe over the governed store (D2).
 *
 * Resolves the brain DB the same way apps/api does (`TEAMKB_DB_PATH`, else
 * `<base>/teamkb.db`) and opens it READ-ONLY — a canary must never create or
 * migrate a database as a side effect. Any failure (no DB file — e.g. the CI
 * fixture brain — missing `index_state` table on an old store, locked file)
 * degrades to `null` = unmeasured, which passes the gate.
 */
export function makeStoreStalenessProbe(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): StalenessProbe {
  return () => {
    const dbPath = env['TEAMKB_DB_PATH']?.trim() || join(getTeamKbBasePath(), 'teamkb.db');
    if (!existsSync(dbPath)) return null;
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      return new IndexStateRepository(db).stalenessSeconds(tenantId);
    } catch {
      return null;
    } finally {
      db?.close();
    }
  };
}

/**
 * Dispatch a CLI invocation. Returns the process exit code (0 = ok, 1 = failure/
 * degraded, 2 = usage error) so `main` and tests share one code path.
 */
export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const makeAdapter =
    deps.makeAdapter ??
    ((tenantId: string, exportDir: string) => new QmdAdapter({ tenantId, exportDir }));

  const [command, ...rest] = argv;
  const { tenantId, exportDir } = resolveCliContext(env);
  const adapter = makeAdapter(tenantId, exportDir);

  if (command === 'reindex') {
    const result = await reindex(adapter);
    if (!result.ok) {
      errLog(`reindex FAILED (tenant=${tenantId}): ${result.error.code}: ${result.error.message}`);
      return 1;
    }
    const { collectionsCreated, indexUpdated } = result.value;
    log(
      `reindex OK (tenant=${tenantId}): collectionsCreated=[${collectionsCreated.join(', ')}], indexUpdated=${indexUpdated}`,
    );
    return 0;
  }

  if (command === 'canary') {
    const heal = rest.includes('--heal');

    // D2 staleness gate: opt-in via --max-staleness-seconds. An invalid value
    // is a usage error (exit 2), NOT a silently skipped gate — a typo'd
    // threshold must never disable the assertion it was meant to enforce.
    let maxStalenessSeconds: number | undefined;
    const maxIdx = rest.indexOf('--max-staleness-seconds');
    if (maxIdx !== -1) {
      const raw = rest[maxIdx + 1];
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        errLog('usage: qmd-index canary [--heal] [--max-staleness-seconds <non-negative seconds>]');
        return 2;
      }
      maxStalenessSeconds = value;
    }
    const stalenessProbe =
      maxStalenessSeconds !== undefined
        ? (deps.makeStalenessProbe ?? makeStoreStalenessProbe)(tenantId, env)
        : undefined;

    const report = await runSearchCanary(adapter, tenantId, {
      heal,
      maxStalenessSeconds,
      stalenessProbe,
    });
    log(formatCanaryReport(report));
    return report.healthy ? 0 : 1;
  }

  errLog('usage: qmd-index <reindex|canary [--heal] [--max-staleness-seconds <seconds>]>');
  return 2;
}

/** Entry point — resolves the exit code and terminates the process. */
export async function main(): Promise<void> {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}

// Direct-execution guard: run `main()` only when this module is the process
// entry (`node dist/cli.js ...`), NOT when imported by tests — the ESM
// equivalent of `require.main === module`. Convert this module's `import.meta.url`
// to a filesystem path with `fileURLToPath` and compare to the invoked script
// path. Building a `file://${argv[1]}` string by hand is fragile: `import.meta.url`
// is URL-encoded (spaces → `%20`) while `argv[1]` is a raw path, so paths with
// spaces/special chars — or Windows backslash separators — would never match.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
