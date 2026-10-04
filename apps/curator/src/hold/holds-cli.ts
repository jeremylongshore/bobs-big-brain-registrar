/**
 * `curator-cli holds` — the human surface for the K6 human-escalation hold
 * queue (Epic K bead K6).
 *
 *   holds list     every open hold, soonest expiry first (read-only)
 *   holds resolve  release (promote, with a chosen audience) or reject ONE hold
 *   holds expire   close every hold whose bound has elapsed (never promotes)
 *
 * `list`, and any `--dry-run`, open the store READ-ONLY, so they structurally
 * cannot write. Output never includes candidate content: ids, titles, audience
 * tiers, trigger names and pattern ids only.
 *
 * Exit: 0 done · 3 the resolution was refused · 2 usage error · 1 I/O failure.
 *
 * @module hold/holds-cli
 */

import { loadOriginSecret } from '@qmd-team-intent-kb/common';
import {
  AuditRepository,
  CandidateRepository,
  MemoryLinksRepository,
  MemoryRepository,
  PolicyRepository,
} from '@qmd-team-intent-kb/store';

import { closeQuietly, requireFlags, tokenizeFlags } from '../cli-args.js';
import type { CliDatabase, CliDbDeps, Parsed } from '../cli-args.js';
import { loadBrainignoreRuleset } from '../import-exclusion/load-brainignore.js';
import { expireHolds, holdLimitsFromEnv, listActiveHolds, resolveMaxActiveHolds } from './hold.js';
import type { ActiveHold } from './hold.js';
import { resolveHold } from './resolve-hold.js';

const HOLDS_USAGE = `Usage: curator-cli holds <list|resolve|expire> [options]

  holds list --db <path> --tenant <id> [--json]
    List every open hold, soonest expiry first. Read-only.

  holds resolve --db <path> --tenant <id> --candidate-id <uuid>
                --resolution <release|reject> --actor <id> --reason <text>
                [--audience <tenant|admins|owner>] [--acknowledge-wider]
                [--role <admin|owner>] [--dry-run] [--json]
    Resolve ONE hold. A human decision: the actor is recorded as a human on the
    receipt. 'release' needs --audience, re-runs the whole deterministic gate
    and promotes with that audience; an audience WIDER than the recommended
    tier also needs --acknowledge-wider. 'reject' retires the candidate (the
    row is kept). --role is the resolver's standing (default owner: the
    operator at the store file); a member is refused.

  holds expire --db <path> --tenant <id> [--dry-run] [--json]
    Close every hold past its expiry to the safe default: not promoted, stamped
    rejected, with an 'expired' receipt. Idempotent.

  --db <path>      SQLite path (required — refuses an implicit in-memory store).
  --tenant <id>    Tenant scope (required).
  --dry-run        Open the store READ-ONLY and report what would happen.
  --json           Emit a JSON envelope in place of the summary.

Exit: 0 done · 3 resolution refused · 2 usage error · 1 I/O failure.
`;

const VALUE_FLAGS = new Set([
  '--db',
  '--tenant',
  '--candidate-id',
  '--resolution',
  '--audience',
  '--actor',
  '--reason',
  '--role',
]);
const BOOL_FLAGS = new Set(['--dry-run', '--json', '--acknowledge-wider']);

/** Exit code for "ran, and the resolution was refused". */
const REFUSED_EXIT = 3;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HoldsOpts {
  dbPath: string;
  tenantId: string;
  dryRun: boolean;
  json: boolean;
  values: ReadonlyMap<string, string>;
  acknowledgeWider: boolean;
}

function parseArgs(
  args: readonly string[],
  required: readonly string[],
): Parsed<{ opts: HoldsOpts }> {
  const tokens = tokenizeFlags(args, VALUE_FLAGS, BOOL_FLAGS);
  if (!tokens.ok) return tokens;
  const { values, bools } = tokens;
  const missing = requireFlags(values, ['--db', '--tenant', ...required]);
  if (!missing.ok) return missing;
  return {
    ok: true,
    opts: {
      dbPath: values.get('--db')!,
      tenantId: values.get('--tenant')!,
      dryRun: bools.has('--dry-run'),
      json: bools.has('--json'),
      values,
      acknowledgeWider: bools.has('--acknowledge-wider'),
    },
  };
}

function repositories(db: CliDatabase) {
  return {
    candidateRepo: new CandidateRepository(db),
    memoryRepo: new MemoryRepository(db),
    auditRepo: new AuditRepository(db),
    policyRepo: new PolicyRepository(db),
    linksRepo: new MemoryLinksRepository(db),
  };
}

function holdJson(hold: ActiveHold): Record<string, unknown> {
  return {
    candidate_id: hold.candidateId,
    title: hold.title,
    category: hold.category,
    author: hold.authorId,
    proposed_by_role: hold.proposedByRole ?? null,
    declared_audience: hold.declaredAudience,
    recommended_audience: hold.recommendedAudience,
    triggers: hold.triggers,
    matched_patterns: hold.matchedPatterns,
    held_at: hold.heldAt,
    expires_at: hold.expiresAt,
    expired: hold.expired,
    recommendations: hold.recommendations.map((r) => ({
      actor: r.actor.id,
      actor_type: r.actor.type,
      verdict: r.verdict,
      audience: r.audience ?? null,
      reasoning: r.reasoning,
      at: r.at,
    })),
  };
}

/** Run `fn` against an open store and map an I/O failure to exit 1. */
function withDb(
  deps: CliDbDeps,
  opts: HoldsOpts,
  readonly: boolean,
  label: string,
  fn: (db: CliDatabase) => number,
): number {
  let db: CliDatabase;
  try {
    db = deps.createDb({ dbPath: opts.dbPath, readonly });
  } catch (err) {
    process.stderr.write(`${label} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  try {
    return fn(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: msg, code: 'HOLDS_FAILED' }) + '\n');
    } else {
      process.stderr.write(`${label} failed: ${msg}\n`);
    }
    return 1;
  } finally {
    closeQuietly(db);
  }
}

function cmdList(opts: HoldsOpts, deps: CliDbDeps): number {
  return withDb(deps, opts, true, 'holds list', (db) => {
    const holds = listActiveHolds(opts.tenantId, repositories(db));
    const maxActive = resolveMaxActiveHolds(holdLimitsFromEnv());
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          tenant_id: opts.tenantId,
          count: holds.length,
          max_active: maxActive,
          expired: holds.filter((h) => h.expired).length,
          holds: holds.map(holdJson),
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(
      `Open holds for ${opts.tenantId}: ${holds.length} of ${maxActive} allowed\n`,
    );
    for (const hold of holds) {
      process.stdout.write(
        `  ${hold.candidateId}  ${hold.expired ? 'EXPIRED' : 'expires'} ${hold.expiresAt}\n` +
          `    title: ${hold.title}\n` +
          `    audience: declared ${hold.declaredAudience}, recommended ${hold.recommendedAudience}\n` +
          `    triggers: ${hold.triggers.join(', ')}\n` +
          (hold.matchedPatterns.length > 0
            ? `    patterns: ${hold.matchedPatterns.join(', ')}\n`
            : '') +
          hold.recommendations
            .map(
              (r) =>
                `    recommendation (${r.actor.type} ${r.actor.id}): ${r.verdict}` +
                `${r.audience !== undefined ? ` as ${r.audience}` : ''} — ${r.reasoning}\n`,
            )
            .join(''),
      );
    }
    return 0;
  });
}

function cmdResolve(opts: HoldsOpts, deps: CliDbDeps): number {
  const candidateId = opts.values.get('--candidate-id')!.trim().toLowerCase();
  if (!UUID_PATTERN.test(candidateId)) {
    process.stderr.write('curator-cli holds resolve: --candidate-id must be a full UUID\n');
    return 2;
  }
  return withDb(deps, opts, opts.dryRun, 'holds resolve', (db) => {
    const result = resolveHold(
      {
        candidateId,
        tenantId: opts.tenantId,
        resolution: opts.values.get('--resolution')!,
        audience: opts.values.get('--audience'),
        acknowledgeWider: opts.acknowledgeWider,
        actor: { type: 'human', id: opts.values.get('--actor')! },
        // The operator at the store file has owner standing, as loopback dev mode does.
        role: opts.values.get('--role') ?? 'owner',
        reason: opts.values.get('--reason')!,
        dryRun: opts.dryRun,
      },
      repositories(db),
      {
        // Load, never create: resolving a hold must not mint an installation secret.
        originSecret: loadOriginSecret(),
        importExclusions: loadBrainignoreRuleset({
          onWarn: (m) => process.stderr.write(`[curator-cli] ${m}\n`),
        }),
      },
    );
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          result.ok
            ? {
                ok: true,
                dry_run: opts.dryRun,
                tenant_id: opts.tenantId,
                candidate_id: result.candidateId,
                resolution: result.resolution,
                audience: result.audience ?? null,
                memory_id: result.memoryId ?? null,
                overrides_recommendation: result.overridesRecommendation ?? false,
                audit_event_id: result.auditEventId,
              }
            : {
                ok: false,
                dry_run: opts.dryRun,
                tenant_id: opts.tenantId,
                candidate_id: result.candidateId,
                code: result.code,
                error: result.error,
                expired_now: result.expiredNow ?? false,
              },
        ) + '\n',
      );
    } else if (result.ok) {
      const prefix = opts.dryRun ? '(dry-run — nothing written) would be ' : '';
      process.stdout.write(
        `hold on ${result.candidateId} ${prefix}${result.resolution}` +
          (result.audience !== undefined ? ` for audience ${result.audience}` : '') +
          (result.memoryId !== undefined ? `  memory=${result.memoryId}` : '') +
          (result.auditEventId !== null ? `  receipt=${result.auditEventId}` : '') +
          '\n',
      );
      if (!opts.dryRun && result.resolution === 'released') {
        process.stdout.write(
          '\nNext: run the exporter in reconcile mode, then reindex, so the new memory is searchable.\n',
        );
      }
    } else {
      process.stdout.write(`refused ${result.candidateId} [${result.code}]: ${result.error}\n`);
    }
    return result.ok ? 0 : REFUSED_EXIT;
  });
}

function cmdExpire(opts: HoldsOpts, deps: CliDbDeps): number {
  return withDb(deps, opts, opts.dryRun, 'holds expire', (db) => {
    const expired = expireHolds(opts.tenantId, repositories(db), { dryRun: opts.dryRun });
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          dry_run: opts.dryRun,
          tenant_id: opts.tenantId,
          expired: expired.length,
          holds: expired.map((e) => ({
            candidate_id: e.candidateId,
            expires_at: e.expiresAt,
            audit_event_id: e.auditEventId,
          })),
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(
      `holds expire ${opts.dryRun ? '(dry-run — nothing written) ' : ''}complete\n` +
        `${opts.dryRun ? 'Would expire' : 'Expired'}: ${expired.length} (none promoted)\n`,
    );
    for (const e of expired) {
      process.stdout.write(`  ${e.candidateId}  expired ${e.expiresAt}\n`);
    }
    return 0;
  });
}

const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  list: [],
  resolve: ['--candidate-id', '--resolution', '--actor', '--reason'],
  expire: [],
};

export async function cmdHolds(args: string[], deps: CliDbDeps): Promise<number> {
  const action = args[0];
  if (action === undefined || !Object.hasOwn(REQUIRED, action)) {
    process.stderr.write(
      `curator-cli holds: ${action === undefined ? 'missing' : `unknown`} action${
        action === undefined ? '' : ` "${action}"`
      }\n\n${HOLDS_USAGE}`,
    );
    return 2;
  }
  const parsed = parseArgs(args.slice(1), REQUIRED[action]!);
  if (!parsed.ok) {
    process.stderr.write(`curator-cli holds ${action}: ${parsed.message}\n\n${HOLDS_USAGE}`);
    return 2;
  }
  if (action === 'list') return cmdList(parsed.opts, deps);
  if (action === 'resolve') return cmdResolve(parsed.opts, deps);
  return cmdExpire(parsed.opts, deps);
}
