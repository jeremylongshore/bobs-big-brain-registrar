/**
 * Bounded human-escalation HOLD for ambiguous audience and secret decisions
 * (Epic K bead K6, decision `000-docs/053-AT-DECR`, reusing the 014-AT-DECR
 * recommend / pipeline-owns split).
 *
 * ## What a hold is
 *
 * A candidate is on hold when BOTH are true:
 *
 *   1. its status is `quarantined` — the EXISTING "awaiting a human" status the
 *      014-AT-DECR capture inbox already uses (no new status, no migration); and
 *   2. the audit chain carries a `held` receipt for it with no `hold_resolved`
 *      receipt after it.
 *
 * The `held` receipt is what makes the hold BOUNDED: it records why the
 * candidate was held and when the hold expires. A plain member-quarantined
 * candidate has no such receipt and is not a K6 hold.
 *
 * ## Who changes state
 *
 *   - ENTRY is a deterministic rule outcome (`evaluateHoldTriggers` in
 *     policy-engine), applied by {@link placeHold}.
 *   - A reviewer, including a model, may attach a recommendation
 *     ({@link recommendOnHold}). That writes a `hold_recommended` receipt and
 *     NOTHING else: no status, no memory, no audience.
 *   - EXIT is a human with admin or owner standing (`resolveHold`, in
 *     `resolve-hold.ts`) or the expiry ({@link expireHolds}), which resolves to
 *     the safe default: not promoted.
 *
 * Every state change and its hash-chained receipt commit in ONE transaction.
 *
 * @module hold/hold
 */

import { randomUUID } from 'node:crypto';

import { AUDIENCE_RANK, deriveAuditEventId, resolveAudience } from '@qmd-team-intent-kb/common';
import type { HoldDecision } from '@qmd-team-intent-kb/policy-engine';
import { AuditEvent as AuditEventSchema } from '@qmd-team-intent-kb/schema';
import type {
  AuditEvent,
  Author,
  CandidateStatus,
  MemoryCandidate,
} from '@qmd-team-intent-kb/schema';
import type {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
} from '@qmd-team-intent-kb/store';

/** The candidate status a hold uses: the existing "awaiting a human" marker. */
export const HOLD_STATUS: CandidateStatus = 'quarantined';

/** How long a hold stays open before it expires to the safe default. */
export const DEFAULT_HOLD_TTL_DAYS = 14;

/** How many holds one tenant may have open at once. */
export const DEFAULT_MAX_ACTIVE_HOLDS = 100;

/** How many distinct recommendations one hold accepts (a looping reviewer cannot bloat the chain). */
export const MAX_RECOMMENDATIONS_PER_HOLD = 10;

/** The system actor recorded on a `held` receipt. */
const HOLD_GATE_ACTOR: Author = { type: 'system', id: 'hold-gate' };

/** The system actor recorded on an `expired` resolution. */
const HOLD_EXPIRY_ACTOR: Author = { type: 'system', id: 'hold-expiry' };

const MS_PER_DAY = 86_400_000;

/** The bounds on the hold queue. Omitted values take the defaults above. */
export interface HoldLimits {
  /** Days a hold stays open. A non-positive or non-finite value takes the default. */
  ttlDays?: number;
  /** Open holds allowed per tenant. `0` holds nothing (every would-be hold is cap-blocked). */
  maxActiveHolds?: number;
}

/** The repositories a hold operation needs (built on ONE connection). */
export interface HoldRepos {
  candidateRepo: CandidateRepository;
  /** Supplies the shared connection every hold transaction runs on. */
  memoryRepo: MemoryRepository;
  auditRepo: AuditRepository;
}

/** A recommendation attached to a hold. Advice only. */
export interface HoldRecommendation {
  auditEventId: string;
  actor: Author;
  verdict: 'release' | 'reject';
  /** The audience the reviewer suggests for a release, when given. */
  audience?: string;
  reasoning: string;
  at: string;
}

/** One open hold, as read back from the candidate row and its receipts. */
export interface ActiveHold {
  candidateId: string;
  tenantId: string;
  title: string;
  category: string;
  authorId: string;
  proposedByRole?: string;
  declaredAudience: string;
  recommendedAudience: string;
  /** Why it was held. Trigger names, never content. */
  triggers: string[];
  /** Pattern ids that fired. Never matched text. */
  matchedPatterns: string[];
  holdEventId: string;
  heldAt: string;
  expiresAt: string;
  /** True when the bound has elapsed: the hold can no longer be released. */
  expired: boolean;
  recommendations: HoldRecommendation[];
}

function resolveTtlDays(limits: HoldLimits | undefined): number {
  const ttl = limits?.ttlDays;
  return ttl !== undefined && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_HOLD_TTL_DAYS;
}

/** The effective open-hold cap for a set of limits. */
export function resolveMaxActiveHolds(limits: HoldLimits | undefined): number {
  const max = limits?.maxActiveHolds;
  return max !== undefined && Number.isInteger(max) && max >= 0 ? max : DEFAULT_MAX_ACTIVE_HOLDS;
}

/** Environment variable: days a hold stays open. */
export const HOLD_TTL_DAYS_ENV = 'TEAMKB_HOLD_TTL_DAYS';
/** Environment variable: open holds allowed per tenant. */
export const HOLD_MAX_ACTIVE_ENV = 'TEAMKB_HOLD_MAX_ACTIVE';

/**
 * Read the hold bounds from the environment (`TEAMKB_HOLD_TTL_DAYS`,
 * `TEAMKB_HOLD_MAX_ACTIVE`). An unset or unparseable value is left out, so the
 * default applies; a bad value never widens a bound.
 */
export function holdLimitsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HoldLimits {
  const limits: HoldLimits = {};
  const ttl = Number(env[HOLD_TTL_DAYS_ENV]?.trim() || NaN);
  if (Number.isFinite(ttl) && ttl > 0) limits.ttlDays = ttl;
  const max = Number(env[HOLD_MAX_ACTIVE_ENV]?.trim() || NaN);
  if (Number.isInteger(max) && max >= 0) limits.maxActiveHolds = max;
  return limits;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * True when `now` is at or past `expiresAt`. An unreadable bound counts as
 * elapsed: a hold whose expiry cannot be read must not stay open forever.
 */
function hasElapsed(expiresAt: string, now: string): boolean {
  const expiry = Date.parse(expiresAt);
  const at = Date.parse(now);
  if (Number.isNaN(expiry) || Number.isNaN(at)) return true;
  return at >= expiry;
}

function toRecommendation(event: AuditEvent): HoldRecommendation {
  const verdict = event.details['verdict'] === 'release' ? 'release' : 'reject';
  const audience = event.details['audience'];
  return {
    auditEventId: event.id,
    actor: event.actor,
    verdict,
    ...(typeof audience === 'string' ? { audience } : {}),
    reasoning: event.reason ?? '',
    at: event.timestamp,
  };
}

function toActiveHold(
  candidate: MemoryCandidate,
  held: AuditEvent,
  recommendations: readonly AuditEvent[],
  now: string,
): ActiveHold {
  const expiresAt = asString(held.details['expiresAt']);
  const declaredAudience = resolveAudience(candidate.metadata.audience);
  return {
    candidateId: candidate.id,
    tenantId: candidate.tenantId,
    title: candidate.title,
    category: candidate.category,
    authorId: candidate.author.id,
    ...(candidate.metadata.proposedByRole !== undefined
      ? { proposedByRole: candidate.metadata.proposedByRole }
      : {}),
    declaredAudience,
    recommendedAudience: asString(held.details['recommendedAudience'], declaredAudience),
    triggers: asStringArray(held.details['triggers']),
    matchedPatterns: asStringArray(held.details['matchedPatterns']),
    holdEventId: held.id,
    heldAt: held.timestamp,
    expiresAt,
    expired: hasElapsed(expiresAt, now),
    recommendations: recommendations.map(toRecommendation),
  };
}

/** Read a candidate without letting one unparseable row abort a listing. */
function findCandidateSafe(repo: CandidateRepository, id: string): MemoryCandidate | null {
  try {
    return repo.findById(id);
  } catch {
    return null;
  }
}

/**
 * The open hold on one candidate, or null when it is not on hold (unknown id,
 * another tenant, never held, already resolved, or no longer `quarantined`).
 */
export function findActiveHold(
  candidateId: string,
  tenantId: string,
  repos: HoldRepos,
  now: string = new Date().toISOString(),
): ActiveHold | null {
  const candidate = findCandidateSafe(repos.candidateRepo, candidateId);
  if (candidate === null || candidate.tenantId !== tenantId) return null;
  if (candidate.status !== HOLD_STATUS) return null;
  const events = repos.auditRepo.findByMemoryAndTenant(candidateId, tenantId);
  const held = events.find((e) => e.action === 'held');
  if (held === undefined || events.some((e) => e.action === 'hold_resolved')) return null;
  return toActiveHold(
    candidate,
    held,
    events.filter((e) => e.action === 'hold_recommended'),
    now,
  );
}

/**
 * Every open hold in a tenant, soonest expiry first. Read-only. A hold past its
 * bound is still listed, marked `expired`, until {@link expireHolds} (or a
 * resolve attempt) closes it; it can no longer be released either way.
 */
export function listActiveHolds(
  tenantId: string,
  repos: HoldRepos,
  now: string = new Date().toISOString(),
): ActiveHold[] {
  const resolved = new Set(
    repos.auditRepo.findByTenantAndAction(tenantId, 'hold_resolved').map((e) => e.memoryId),
  );
  const recommendations = new Map<string, AuditEvent[]>();
  for (const event of repos.auditRepo.findByTenantAndAction(tenantId, 'hold_recommended')) {
    const list = recommendations.get(event.memoryId) ?? [];
    list.push(event);
    recommendations.set(event.memoryId, list);
  }
  const holds: ActiveHold[] = [];
  for (const held of repos.auditRepo.findByTenantAndAction(tenantId, 'held')) {
    if (resolved.has(held.memoryId)) continue;
    const candidate = findCandidateSafe(repos.candidateRepo, held.memoryId);
    if (candidate === null || candidate.tenantId !== tenantId) continue;
    if (candidate.status !== HOLD_STATUS) continue;
    holds.push(toActiveHold(candidate, held, recommendations.get(held.memoryId) ?? [], now));
  }
  return holds.sort(
    (a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.candidateId.localeCompare(b.candidateId),
  );
}

/** Outcome of {@link placeHold}. */
export type PlaceHoldResult =
  /** The candidate is now on hold; the receipt is written. */
  | { status: 'held'; hold: ActiveHold }
  /** It was already on hold. Nothing was written (idempotent). */
  | { status: 'already_held'; hold: ActiveHold }
  /** Dry-run: it would be held. Nothing was written. */
  | { status: 'would_hold'; expiresAt: string }
  /** The tenant's hold queue is full. Nothing was written; the candidate is NOT promoted. */
  | { status: 'cap_reached'; active: number; max: number }
  /** No stored row in a holdable status. Nothing was written; the candidate is NOT promoted. */
  | { status: 'not_holdable'; reason: string };

/** Options for {@link placeHold}. */
export interface PlaceHoldOptions {
  limits?: HoldLimits;
  /** Decide and report without writing. */
  dryRun?: boolean;
  /** Injected clock (ISO-8601). Defaults to the wall clock. */
  now?: string;
}

/**
 * Put a candidate on hold because a deterministic rule outcome said so.
 *
 * The status flip to `quarantined` and the `held` receipt commit in one
 * transaction, with the cap counted inside it, so two writers cannot both take
 * the last slot. Idempotent: a candidate already on hold is reported as such
 * and nothing is written. Past the cap it FAILS CLOSED: the candidate is left
 * where it was, unpromoted, and the caller reports the refusal.
 *
 * The receipt carries trigger names, audience tiers and pattern ids. It never
 * carries candidate content.
 */
export function placeHold(
  candidate: MemoryCandidate,
  decision: HoldDecision,
  repos: HoldRepos,
  options: PlaceHoldOptions = {},
): PlaceHoldResult {
  const now = options.now ?? new Date().toISOString();
  const ttlDays = resolveTtlDays(options.limits);
  const max = resolveMaxActiveHolds(options.limits);
  const expiresAt = new Date(Date.parse(now) + ttlDays * MS_PER_DAY).toISOString();

  const attempt = (): PlaceHoldResult => {
    const existing = findActiveHold(candidate.id, candidate.tenantId, repos, now);
    if (existing !== null) return { status: 'already_held', hold: existing };

    const stored = findCandidateSafe(repos.candidateRepo, candidate.id);
    if (stored === null || stored.tenantId !== candidate.tenantId) {
      return { status: 'not_holdable', reason: 'the candidate has no stored row to hold' };
    }
    if (stored.status !== 'inbox' && stored.status !== HOLD_STATUS) {
      return {
        status: 'not_holdable',
        reason: `the candidate is already '${stored.status}' and cannot be held`,
      };
    }
    const events = repos.auditRepo.findByMemoryAndTenant(candidate.id, candidate.tenantId);
    if (events.some((e) => e.action === 'held')) {
      // A candidate is held at most once: a resolved hold is never reopened.
      return { status: 'not_holdable', reason: 'an earlier hold on the candidate was resolved' };
    }

    const active = listActiveHolds(candidate.tenantId, repos, now).length;
    if (active >= max) return { status: 'cap_reached', active, max };
    if (options.dryRun === true) return { status: 'would_hold', expiresAt };

    const held = AuditEventSchema.parse({
      // Content-derived: one `held` receipt per candidate, the same id on every clone.
      id: deriveAuditEventId(candidate.id, 'held'),
      action: 'held',
      memoryId: candidate.id,
      tenantId: candidate.tenantId,
      actor: HOLD_GATE_ACTOR,
      reason: `Held for human review: ${decision.triggers.join(', ')}`,
      details: {
        candidateId: candidate.id,
        triggers: decision.triggers,
        declaredAudience: decision.declaredAudience,
        recommendedAudience: decision.recommendedAudience,
        basis: decision.basis,
        matchedPatterns: decision.matchedPatterns,
        triggerRuleIds: decision.triggerRuleIds,
        otherFlags: decision.otherFlags,
        ttlDays,
        expiresAt,
      },
      timestamp: now,
    });
    repos.candidateRepo.updateStatus(candidate.id, HOLD_STATUS, candidate.tenantId);
    repos.auditRepo.insert(held);
    return { status: 'held', hold: toActiveHold(stored, held, [], now) };
  };

  // Dry-run takes no write lock: it must work on a store opened read-only.
  if (options.dryRun === true) return attempt();
  return repos.memoryRepo.connection.transaction(attempt).immediate();
}

/** Why a recommendation was not recorded. */
export type HoldRecommendRefusalCode =
  | 'not_on_hold'
  | 'hold_expired'
  | 'missing_reasoning'
  | 'missing_actor'
  | 'unknown_verdict'
  | 'unknown_audience'
  | 'recommendation_cap';

/** One recommendation request. */
export interface RecommendOnHoldInput {
  candidateId: string;
  tenantId: string;
  /** Who recommends. A model is welcome here: this is the only thing a model may do to a hold. */
  actor: Author;
  verdict: string;
  /** The audience suggested for a release. */
  audience?: string;
  reasoning: string;
  now?: string;
}

/** Outcome of {@link recommendOnHold}. */
export type RecommendOnHoldResult =
  | { ok: true; candidateId: string; auditEventId: string; duplicate: boolean }
  | { ok: false; candidateId: string; code: HoldRecommendRefusalCode; error: string };

/**
 * Attach a recommendation to an open hold.
 *
 * This is the whole of what a model may do to a hold, and it changes no state:
 * it appends one `hold_recommended` receipt. The candidate's status, its
 * audience and durable memory are untouched, and an expired hold is refused
 * rather than expired here. A repeat of the same reviewer's same verdict is a
 * no-op, and a hold accepts a bounded number of recommendations.
 */
export function recommendOnHold(
  input: RecommendOnHoldInput,
  repos: HoldRepos,
): RecommendOnHoldResult {
  const { candidateId } = input;
  const refuse = (code: HoldRecommendRefusalCode, error: string): RecommendOnHoldResult => ({
    ok: false,
    candidateId,
    code,
    error,
  });
  if (input.reasoning.trim() === '') {
    return refuse('missing_reasoning', 'A recommendation needs its reasoning');
  }
  if (input.actor.id.trim() === '') {
    return refuse('missing_actor', 'A recommendation needs an actor');
  }
  if (input.verdict !== 'release' && input.verdict !== 'reject') {
    return refuse(
      'unknown_verdict',
      `Unknown verdict "${input.verdict}" (expected release or reject)`,
    );
  }
  if (input.audience !== undefined && !Object.hasOwn(AUDIENCE_RANK, input.audience)) {
    return refuse(
      'unknown_audience',
      `Unknown audience "${input.audience}" (expected one of: ${Object.keys(AUDIENCE_RANK).join(', ')})`,
    );
  }
  const now = input.now ?? new Date().toISOString();
  const verdict = input.verdict;

  return repos.memoryRepo.connection
    .transaction((): RecommendOnHoldResult => {
      const hold = findActiveHold(candidateId, input.tenantId, repos, now);
      if (hold === null) {
        return refuse('not_on_hold', `Candidate ${candidateId} is not on hold`);
      }
      if (hold.expired) {
        return refuse('hold_expired', `The hold on candidate ${candidateId} has expired`);
      }
      const same = hold.recommendations.find(
        (r) =>
          r.actor.id === input.actor.id && r.verdict === verdict && r.audience === input.audience,
      );
      if (same !== undefined) {
        return { ok: true, candidateId, auditEventId: same.auditEventId, duplicate: true };
      }
      if (hold.recommendations.length >= MAX_RECOMMENDATIONS_PER_HOLD) {
        return refuse(
          'recommendation_cap',
          `The hold already carries ${MAX_RECOMMENDATIONS_PER_HOLD} recommendations`,
        );
      }
      const auditEventId = randomUUID();
      repos.auditRepo.insert(
        AuditEventSchema.parse({
          id: auditEventId,
          action: 'hold_recommended',
          memoryId: candidateId,
          tenantId: input.tenantId,
          actor: input.actor,
          reason: input.reasoning,
          details: {
            candidateId,
            holdEventId: hold.holdEventId,
            verdict,
            ...(input.audience !== undefined ? { audience: input.audience } : {}),
          },
          timestamp: now,
        }),
      );
      return { ok: true, candidateId, auditEventId, duplicate: false };
    })
    .immediate();
}

/** How a hold ended. */
export type HoldResolution = 'released' | 'rejected' | 'expired';

/**
 * Write the `hold_resolved` receipt for a hold. The caller runs this INSIDE the
 * transaction that changes the candidate's status, so the two commit together.
 * Returns the receipt's id.
 */
export function writeHoldResolved(
  hold: ActiveHold,
  resolution: HoldResolution,
  actor: Author,
  reason: string,
  details: Record<string, unknown>,
  auditRepo: AuditRepository,
  now: string,
): string {
  const auditEventId = deriveAuditEventId(hold.candidateId, 'hold_resolved');
  auditRepo.insert(
    AuditEventSchema.parse({
      // Content-derived: a hold is resolved exactly once.
      id: auditEventId,
      action: 'hold_resolved',
      memoryId: hold.candidateId,
      tenantId: hold.tenantId,
      actor,
      reason,
      details: {
        candidateId: hold.candidateId,
        holdEventId: hold.holdEventId,
        resolution,
        declaredAudience: hold.declaredAudience,
        recommendedAudience: hold.recommendedAudience,
        ...details,
      },
      timestamp: now,
    }),
  );
  return auditEventId;
}

/**
 * Close one expired hold to the SAFE DEFAULT: the candidate is stamped
 * `rejected` (never promoted, never deleted) with an `expired` receipt, in one
 * transaction. The caller has already established that the hold is expired.
 */
export function expireHold(hold: ActiveHold, repos: HoldRepos, now: string): string {
  return repos.memoryRepo.connection
    .transaction((): string => {
      repos.candidateRepo.updateStatus(hold.candidateId, 'rejected', hold.tenantId);
      return writeHoldResolved(
        hold,
        'expired',
        HOLD_EXPIRY_ACTOR,
        `Hold expired unresolved at ${hold.expiresAt}: not promoted`,
        { expiresAt: hold.expiresAt },
        repos.auditRepo,
        now,
      );
    })
    .immediate();
}

/** One hold closed (or, in dry-run, that would be closed) by {@link expireHolds}. */
export interface ExpiredHold {
  candidateId: string;
  expiresAt: string;
  /** The `hold_resolved` receipt's id; null in dry-run. */
  auditEventId: string | null;
}

/**
 * Close every hold in a tenant whose bound has elapsed. Each closes in its own
 * transaction with its own receipt. Idempotent: a second run finds nothing to
 * close. Expiry NEVER promotes.
 */
export function expireHolds(
  tenantId: string,
  repos: HoldRepos,
  options: { now?: string; dryRun?: boolean } = {},
): ExpiredHold[] {
  const now = options.now ?? new Date().toISOString();
  return listActiveHolds(tenantId, repos, now)
    .filter((hold) => hold.expired)
    .map((hold) => ({
      candidateId: hold.candidateId,
      expiresAt: hold.expiresAt,
      auditEventId: options.dryRun === true ? null : expireHold(hold, repos, now),
    }));
}
