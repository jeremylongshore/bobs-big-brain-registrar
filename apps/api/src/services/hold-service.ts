import { isAudienceVisibleToRole } from '@qmd-team-intent-kb/common';
import type { ReaderRole } from '@qmd-team-intent-kb/common';
import {
  listActiveHolds,
  recommendOnHold,
  resolveHold,
  resolveMaxActiveHolds,
  type ActiveHold,
  type BrainignoreRuleset,
  type HoldLimits,
  type ResolveHoldRefusalCode,
} from '@qmd-team-intent-kb/curator';
import type { Author } from '@qmd-team-intent-kb/schema';
import type {
  AuditRepository,
  CandidateRepository,
  MemoryLinksRepository,
  MemoryRepository,
  PolicyRepository,
} from '@qmd-team-intent-kb/store';
import { ApiError, badRequest, notFound, unprocessable } from '../errors.js';

/** The hold queue as one caller is allowed to see it. */
export interface HoldListing {
  tenantId: string;
  /** Open holds the caller may see. */
  count: number;
  /** Open holds allowed per tenant. */
  maxActive: number;
  /** Open holds hidden because they declare an audience above the caller's standing. */
  hiddenAboveStanding: number;
  holds: ActiveHold[];
}

/** A resolution as returned to the API caller. */
export interface HoldResolutionResponse {
  ok: true;
  candidateId: string;
  resolution: 'released' | 'rejected';
  audience?: string;
  memoryId?: string;
  overridesRecommendation?: boolean;
  auditEventId: string | null;
}

/** HTTP status for each refusal the curator's `resolveHold` can return. */
const RESOLVE_REFUSAL_STATUS: Readonly<Record<ResolveHoldRefusalCode, number>> = {
  missing_reason: 400,
  missing_actor: 400,
  unknown_resolution: 400,
  missing_audience: 400,
  unknown_audience: 400,
  not_human: 403,
  forbidden_role: 403,
  // 404, not 403: a hold above the caller's standing is not disclosed to exist.
  not_on_hold: 404,
  audience_above_standing: 404,
  hold_expired: 422,
  wider_than_recommended: 422,
  gate_refused: 422,
  still_flagged: 422,
};

/**
 * The API face of the K6 human-escalation hold queue. A thin wrapper: every
 * decision is the curator's (`listActiveHolds`, `recommendOnHold`,
 * `resolveHold`), so the API, the batch curator and the CLI cannot disagree.
 */
export class HoldService {
  constructor(
    private readonly candidateRepo: CandidateRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly policyRepo: PolicyRepository,
    private readonly auditRepo: AuditRepository,
    private readonly linksRepo?: MemoryLinksRepository,
    private readonly originSecret?: string,
    private readonly importExclusions?: BrainignoreRuleset,
    private readonly holdLimits?: HoldLimits,
  ) {}

  private get repos() {
    return {
      candidateRepo: this.candidateRepo,
      memoryRepo: this.memoryRepo,
      auditRepo: this.auditRepo,
    };
  }

  /** List the open holds a caller with `role` may see. */
  list(tenantId: string | undefined, role: ReaderRole): HoldListing {
    const tenant = requireTenant(tenantId);
    const all = listActiveHolds(tenant, this.repos);
    const holds = all.filter((h) => isAudienceVisibleToRole(h.declaredAudience, role));
    return {
      tenantId: tenant,
      count: holds.length,
      maxActive: resolveMaxActiveHolds(this.holdLimits),
      hiddenAboveStanding: all.length - holds.length,
      holds,
    };
  }

  /**
   * Attach a recommendation. Advice only: one `hold_recommended` receipt and no
   * state change. A hold above the caller's standing answers 404.
   */
  recommend(
    candidateId: string,
    tenantId: string | undefined,
    role: ReaderRole,
    actor: Author,
    body: { verdict?: unknown; audience?: unknown; reasoning?: unknown },
  ): { ok: true; candidateId: string; auditEventId: string; duplicate: boolean } {
    const tenant = requireTenant(tenantId);
    if (typeof body.verdict !== 'string')
      throw badRequest('verdict is required (release or reject)');
    if (typeof body.reasoning !== 'string') throw badRequest('reasoning is required');
    if (body.audience !== undefined && typeof body.audience !== 'string') {
      throw badRequest('audience must be a string');
    }
    this.assertVisible(candidateId, tenant, role);
    const result = recommendOnHold(
      {
        candidateId,
        tenantId: tenant,
        actor,
        verdict: body.verdict,
        ...(body.audience !== undefined ? { audience: body.audience } : {}),
        reasoning: body.reasoning,
      },
      this.repos,
    );
    if (result.ok) return result;
    if (result.code === 'not_on_hold') throw notFound(result.error);
    if (result.code === 'hold_expired' || result.code === 'recommendation_cap') {
      throw unprocessable(result.error, result.code);
    }
    throw new ApiError(400, result.error, result.code);
  }

  /** Resolve a hold on a person's decision: release with an audience, or reject. */
  resolve(
    candidateId: string,
    tenantId: string | undefined,
    role: ReaderRole,
    actor: Author,
    body: {
      resolution?: unknown;
      audience?: unknown;
      reason?: unknown;
      acknowledgeWider?: unknown;
    },
  ): HoldResolutionResponse {
    const tenant = requireTenant(tenantId);
    if (typeof body.resolution !== 'string') {
      throw badRequest('resolution is required (release or reject)');
    }
    if (typeof body.reason !== 'string') throw badRequest('reason is required');
    if (body.audience !== undefined && typeof body.audience !== 'string') {
      throw badRequest('audience must be a string');
    }
    const result = resolveHold(
      {
        candidateId,
        tenantId: tenant,
        resolution: body.resolution,
        ...(body.audience !== undefined ? { audience: body.audience } : {}),
        // Strict `=== true`: a truthy string never acknowledges a wider audience.
        acknowledgeWider: body.acknowledgeWider === true,
        actor,
        role,
        reason: body.reason,
      },
      {
        ...this.repos,
        policyRepo: this.policyRepo,
        ...(this.linksRepo !== undefined ? { linksRepo: this.linksRepo } : {}),
      },
      {
        ...(this.originSecret !== undefined ? { originSecret: this.originSecret } : {}),
        ...(this.importExclusions !== undefined ? { importExclusions: this.importExclusions } : {}),
      },
    );
    if (!result.ok) {
      const status = RESOLVE_REFUSAL_STATUS[result.code];
      // Do not say WHY a hold above the caller's standing is unavailable.
      throw new ApiError(
        status,
        result.code === 'audience_above_standing'
          ? `Candidate ${candidateId} is not on hold in tenant ${tenant}`
          : result.error,
        result.code === 'audience_above_standing' ? 'not_on_hold' : result.code,
      );
    }
    return {
      ok: true,
      candidateId: result.candidateId,
      resolution: result.resolution,
      ...(result.audience !== undefined ? { audience: result.audience } : {}),
      ...(result.memoryId !== undefined ? { memoryId: result.memoryId } : {}),
      ...(result.overridesRecommendation !== undefined
        ? { overridesRecommendation: result.overridesRecommendation }
        : {}),
      auditEventId: result.auditEventId,
    };
  }

  /** 404 unless the candidate is on hold AND the caller may see it. */
  private assertVisible(candidateId: string, tenantId: string, role: ReaderRole): void {
    const visible = listActiveHolds(tenantId, this.repos).some(
      (h) => h.candidateId === candidateId && isAudienceVisibleToRole(h.declaredAudience, role),
    );
    if (!visible) throw notFound(`Candidate ${candidateId} is not on hold in tenant ${tenantId}`);
  }
}

function requireTenant(tenantId: string | undefined): string {
  if (tenantId === undefined || tenantId.trim().length === 0) {
    throw badRequest('tenantId query parameter is required');
  }
  return tenantId;
}
