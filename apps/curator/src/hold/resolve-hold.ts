/**
 * Resolving a human-escalation hold (Epic K bead K6).
 *
 * A hold ends one of three ways. Two are a human's decision and live here:
 * RELEASE (promote, with an audience the human chose) and REJECT. The third is
 * the expiry, in `hold.ts`. A model resolves nothing: {@link resolveHold}
 * refuses any actor that is not a human with admin or owner standing.
 *
 * A release is NOT a bypass. The released candidate goes back through the whole
 * deterministic gate (disclosure floor, dedup, redaction, origin, import
 * exclusion, policy, supersession) exactly as 014-AT-DECR section 7 requires of
 * `brain_approve`. The human answers the one question the rules could not —
 * which audience — and that resolves the audience and secret-scan flags the
 * hold covered. A hard reject, or a flag from any other rule, still stops it.
 *
 * The state change and its `hold_resolved` receipt (and, for a release, the
 * memory and its `promoted` receipt) commit in ONE transaction.
 *
 * @module hold/resolve-hold
 */

import {
  AUDIENCE_RANK,
  DisclosureRejectedError,
  assertDisclosureClean,
  isAudienceVisibleToRole,
} from '@qmd-team-intent-kb/common';
import { unresolvedFlagsAfterRelease } from '@qmd-team-intent-kb/policy-engine';
import { Audience, MemoryCandidate as MemoryCandidateSchema } from '@qmd-team-intent-kb/schema';
import type { Author } from '@qmd-team-intent-kb/schema';
import type { MemoryLinksRepository, PolicyRepository } from '@qmd-team-intent-kb/store';

import { Curator } from '../curator.js';
import type { BrainignoreRuleset } from '../import-exclusion/brainignore.js';
import { expireHold, findActiveHold, writeHoldResolved } from './hold.js';
import type { ActiveHold, HoldRepos } from './hold.js';

/** Roles with standing to resolve a hold (K2 roles; a member never has it). */
const RESOLVER_ROLES: readonly string[] = Object.freeze(['admin', 'owner']);

/** Why a resolution was refused. Nothing is written for any of these except `hold_expired`. */
export type ResolveHoldRefusalCode =
  | 'missing_reason'
  | 'missing_actor'
  /** The actor is a model or a system, not a person. */
  | 'not_human'
  /** The role has no standing to resolve a hold (a member, or an unknown role). */
  | 'forbidden_role'
  | 'unknown_resolution'
  | 'not_on_hold'
  /** The candidate declares an audience the resolver is not cleared to read. */
  | 'audience_above_standing'
  /** The bound elapsed. The hold is closed to the safe default (not promoted). */
  | 'hold_expired'
  | 'missing_audience'
  | 'unknown_audience'
  /** The chosen audience is wider than the deterministic recommendation and was not acknowledged. */
  | 'wider_than_recommended'
  /** The deterministic gate refused the candidate (secret, duplicate, redacted, origin, import exclusion, policy reject). */
  | 'gate_refused'
  /** A rule the hold does not cover still flags the candidate. */
  | 'still_flagged';

/** One resolution request. */
export interface ResolveHoldInput {
  candidateId: string;
  /** Tenant scope: a hold in another tenant is reported as not on hold. */
  tenantId: string;
  /** `release` (promote with `audience`) or `reject`. */
  resolution: string;
  /** The audience the human chose. Required for a release. */
  audience?: string;
  /**
   * Explicit acknowledgment that the chosen audience is WIDER than the
   * deterministic recommendation. Without it such a release is refused.
   */
  acknowledgeWider?: boolean;
  /** Who is resolving. Must be a human; recorded on every receipt. */
  actor: Author;
  /** The resolver's standing: `admin` or `owner`. */
  role: string;
  /** Why. Recorded verbatim on the receipt. */
  reason: string;
  /** Validate, run the gate and report without writing. */
  dryRun?: boolean;
  /** Injected clock (ISO-8601). Defaults to the wall clock. */
  now?: string;
}

/** Repositories a resolution needs (all on ONE connection). */
export interface ResolveHoldDeps extends HoldRepos {
  policyRepo: PolicyRepository;
  linksRepo?: MemoryLinksRepository;
}

/** Gate configuration a release re-runs with, the same values the batch curator takes. */
export interface ResolveHoldOptions {
  originSecret?: string;
  importExclusions?: BrainignoreRuleset;
}

/** Outcome of {@link resolveHold}. */
export type ResolveHoldResult =
  | {
      ok: true;
      candidateId: string;
      resolution: 'released' | 'rejected';
      /** The audience the memory was promoted with (release only). */
      audience?: string;
      /** The promoted memory's id (release only). */
      memoryId?: string;
      /** True when the chosen audience is wider than the deterministic recommendation. */
      overridesRecommendation?: boolean;
      /** The `hold_resolved` receipt's id; null in dry-run (nothing was written). */
      auditEventId: string | null;
      dryRun: boolean;
    }
  | {
      ok: false;
      candidateId: string;
      code: ResolveHoldRefusalCode;
      error: string;
      /** True when this call closed the hold as expired. */
      expiredNow?: boolean;
    };

function rankOf(audience: string): number {
  // An unknown tier ranks as the narrowest: it can never look wider than it is.
  return Object.hasOwn(AUDIENCE_RANK, audience)
    ? AUDIENCE_RANK[audience]!
    : Number.MAX_SAFE_INTEGER;
}

/**
 * Resolve one hold. Deterministic and synchronous; a refusal comes back as
 * `{ ok: false, code }` and never throws.
 */
export function resolveHold(
  input: ResolveHoldInput,
  deps: ResolveHoldDeps,
  options: ResolveHoldOptions = {},
): ResolveHoldResult {
  const { candidateId } = input;
  const dryRun = input.dryRun === true;
  const refuse = (code: ResolveHoldRefusalCode, error: string): ResolveHoldResult => ({
    ok: false,
    candidateId,
    code,
    error,
  });

  if (input.reason.trim() === '') {
    return refuse('missing_reason', 'A reason is required to resolve a hold');
  }
  if (input.actor.id.trim() === '') {
    return refuse('missing_actor', 'An actor is required to resolve a hold');
  }
  if (input.actor.type !== 'human') {
    return refuse(
      'not_human',
      'Only a human resolves a hold. A model or agent may attach a recommendation; it cannot release or reject.',
    );
  }
  if (!RESOLVER_ROLES.includes(input.role)) {
    return refuse('forbidden_role', 'Resolving a hold requires admin or owner standing');
  }
  if (input.resolution !== 'release' && input.resolution !== 'reject') {
    return refuse(
      'unknown_resolution',
      `Unknown resolution "${input.resolution}" (expected release or reject)`,
    );
  }

  const now = input.now ?? new Date().toISOString();
  const hold = findActiveHold(candidateId, input.tenantId, deps, now);
  if (hold === null) {
    return refuse(
      'not_on_hold',
      `Candidate ${candidateId} is not on hold in tenant ${input.tenantId}`,
    );
  }
  if (!isAudienceVisibleToRole(hold.declaredAudience, input.role)) {
    return refuse(
      'audience_above_standing',
      `The held candidate declares audience "${hold.declaredAudience}", above ${input.role} standing`,
    );
  }
  if (hold.expired) {
    // Past its bound a hold can only close to the safe default, never promote.
    if (!dryRun) expireHold(hold, deps, now);
    return {
      ok: false,
      candidateId,
      code: 'hold_expired',
      error: `The hold expired at ${hold.expiresAt}; the candidate ${dryRun ? 'would be' : 'was'} closed unpromoted`,
      expiredNow: !dryRun,
    };
  }

  if (input.resolution === 'reject') {
    if (dryRun) {
      return { ok: true, candidateId, resolution: 'rejected', auditEventId: null, dryRun };
    }
    const auditEventId = deps.memoryRepo.connection
      .transaction((): string => {
        deps.candidateRepo.updateStatus(candidateId, 'rejected', input.tenantId);
        return writeHoldResolved(
          hold,
          'rejected',
          input.actor,
          input.reason,
          { resolverRole: input.role },
          deps.auditRepo,
          now,
        );
      })
      .immediate();
    return { ok: true, candidateId, resolution: 'rejected', auditEventId, dryRun };
  }

  return release(input, hold, deps, options, now);
}

/** The release path: re-run the gate, then promote with the chosen audience. */
function release(
  input: ResolveHoldInput,
  hold: ActiveHold,
  deps: ResolveHoldDeps,
  options: ResolveHoldOptions,
  now: string,
): ResolveHoldResult {
  const { candidateId } = input;
  const dryRun = input.dryRun === true;
  const refuse = (code: ResolveHoldRefusalCode, error: string): ResolveHoldResult => ({
    ok: false,
    candidateId,
    code,
    error,
  });

  if (input.audience === undefined || input.audience.trim() === '') {
    return refuse('missing_audience', 'A release needs the audience the memory is for');
  }
  const chosen = Audience.safeParse(input.audience);
  if (!chosen.success) {
    return refuse(
      'unknown_audience',
      `Unknown audience "${input.audience}" (expected one of: ${Audience.options.join(', ')})`,
    );
  }
  const audience = chosen.data;
  const overridesRecommendation = rankOf(audience) < rankOf(hold.recommendedAudience);
  if (overridesRecommendation && input.acknowledgeWider !== true) {
    return refuse(
      'wider_than_recommended',
      `Audience "${audience}" is wider than the recommended "${hold.recommendedAudience}". ` +
        'Release at the recommended tier, or acknowledge the wider audience explicitly.',
    );
  }

  const stored = deps.candidateRepo.findById(candidateId);
  if (stored === null) {
    return refuse('not_on_hold', `Candidate ${candidateId} is not on hold`);
  }
  // The memory carries the HUMAN-CHOSEN audience. The candidate row keeps what
  // was proposed; the receipt records both.
  const released = MemoryCandidateSchema.parse({
    ...stored,
    metadata: { ...stored.metadata, audience },
  });

  // Hard floor (014-AT-DECR section 7.1): a release never moves a secret or PII
  // into durable memory, whatever the policy configuration.
  try {
    assertDisclosureClean(released);
  } catch (err) {
    if (err instanceof DisclosureRejectedError) {
      return refuse(
        'gate_refused',
        'The disclosure gate refused the candidate: its content holds disallowed material. Nothing was promoted.',
      );
    }
    throw err;
  }

  const curator = new Curator(
    {
      candidateRepo: deps.candidateRepo,
      memoryRepo: deps.memoryRepo,
      policyRepo: deps.policyRepo,
      auditRepo: deps.auditRepo,
      ...(deps.linksRepo !== undefined ? { linksRepo: deps.linksRepo } : {}),
    },
    {
      tenantId: input.tenantId,
      dryRun,
      suppressRejectionReceipts: true,
      ...(options.originSecret !== undefined ? { originSecret: options.originSecret } : {}),
      ...(options.importExclusions !== undefined
        ? { importExclusions: options.importExclusions }
        : {}),
    },
  );

  const run = (): ResolveHoldResult => {
    const result = curator.processSingle(released, undefined, {
      promotedBy: input.actor,
      promotionReason: `Released from hold: ${input.reason}`,
    });
    if (result.outcome !== 'promoted') {
      if (result.outcome === 'flagged' && result.pipelineResult !== undefined) {
        const unresolved = unresolvedFlagsAfterRelease(result.pipelineResult);
        return refuse(
          'still_flagged',
          `Rules a hold does not cover still flag the candidate: ${unresolved.join(', ')}. Nothing was promoted.`,
        );
      }
      return refuse(
        'gate_refused',
        `The deterministic gate refused the candidate: ${result.reason}. Nothing was promoted.`,
      );
    }
    const base = {
      ok: true as const,
      candidateId,
      resolution: 'released' as const,
      audience,
      ...(result.memoryId !== undefined ? { memoryId: result.memoryId } : {}),
      overridesRecommendation,
      dryRun,
    };
    if (dryRun) return { ...base, auditEventId: null };
    deps.candidateRepo.updateStatus(candidateId, 'promoted', input.tenantId);
    const auditEventId = writeHoldResolved(
      hold,
      'released',
      input.actor,
      input.reason,
      {
        audience,
        overridesRecommendation,
        resolverRole: input.role,
        memoryId: result.memoryId,
        resolvedFlags: result.pipelineResult?.flaggedBy ?? [],
      },
      deps.auditRepo,
      now,
    );
    return { ...base, auditEventId };
  };

  // One transaction: the memory, its `promoted` receipt, the candidate's status
  // and the `hold_resolved` receipt commit together (promote()'s own transaction
  // nests as a savepoint). Dry-run takes no write lock.
  return dryRun ? run() : deps.memoryRepo.connection.transaction(run).immediate();
}
