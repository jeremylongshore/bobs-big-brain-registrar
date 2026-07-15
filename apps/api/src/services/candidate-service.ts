import type { AuditRepository, CandidateRepository } from '@qmd-team-intent-kb/store';
import { AuditEvent, CandidateStatus, MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  computeContentHash,
  deriveAuditEventId,
  scanDisclosureFields,
  collectFreeTextFields,
} from '@qmd-team-intent-kb/common';
import type { TokenRole } from '../auth/token-registry.js';
import { badRequest, notFound, unprocessable } from '../errors.js';

/**
 * The bearer-token identity of the caller proposing a candidate. Resolved by the
 * auth middleware onto the request (`request.actor` / `request.role` /
 * `request.tenants`) and threaded into {@link CandidateService.intake} so the
 * intake path can OVERRIDE the client-supplied trust-bearing fields server-side
 * (R8, bead compile-then-govern-jfv.6.7).
 *
 * All fields are optional: dev no-auth intake and the direct-service unit tests
 * pass an empty context, in which case the identity-derived overrides are no-ops
 * (author/trust/tenant are left as parsed) but the never-trusted-from-client
 * fields (prePolicyFlags) are still reset server-side.
 */
export interface IntakeActorContext {
  /** Audit actor the bearer token belongs to (undefined in dev no-auth). */
  actor?: string;
  /** Role the token grants. A `member`'s asserted trust is never honored. */
  role?: TokenRole;
  /** Tenant allowlist bound to the token (undefined/empty = unscoped). */
  tenants?: readonly string[];
}

/**
 * Apply the R8 server-side intake overrides to a *parsed* candidate — the single
 * place the brain refuses to trust a team-mode client for the trust-bearing
 * fields (bead compile-then-govern-jfv.6.7).
 *
 * In team mode the CLIENT builds the entire `MemoryCandidate` and the server used
 * to `safeParse` it and trust it verbatim. That let a member (or a leaked member
 * token) assert `trustLevel:'high'`, forge `author`, name an arbitrary
 * `tenantId`, and pre-clear `prePolicyFlags.potentialSecret:false`. Each override
 * below re-derives one of those fields from the SERVER's token identity instead:
 *
 *  1. **author** ← the token identity (`{ type:'human', id: actor }`). Preserves
 *     real provenance and neutralizes the client's hardcoded `governed-brain`
 *     author, so proposals are no longer byte-identical in authorship.
 *  2. **trustLevel** ← forced to the lowest level (`untrusted`) for a `member`.
 *     `source-trust-rule` reads `candidate.trustLevel` verbatim, so an un-forced
 *     `high` would clear a min-trust gate a member should never clear. An
 *     admin/unknown role keeps its asserted level.
 *  3. **tenantId** ← bound to the token's tenant when the token is scoped to
 *     exactly one tenant. (For a scoped multi-tenant token the tenancy guard has
 *     already validated the supplied tenantId is in-allowlist; an unscoped token
 *     — the single-tenant team default — keeps the supplied value.) Defense in
 *     depth beside the tenancy guard, which independently rejects a scoped
 *     token's out-of-allowlist tenantId with 403 before intake runs.
 *  4. **prePolicyFlags** ← reset to server defaults (all false). These are
 *     advisory capture-time hints; the durable secret backstop is the disclosure
 *     gate (rejects at 422 pre-insert) and the deterministic policy pipeline's
 *     `secret_detection` rule (re-scans content at promotion, never reading this
 *     flag). A client's self-asserted `potentialSecret:false` must never be
 *     trusted, so the whole struct is server-owned.
 *  5. **metadata.proposedByRole** ← stamped with the proposer's role so a future
 *     auto-govern step (B1) can quarantine member-authored proposals behind admin
 *     review. Marker only — the quarantine ENFORCEMENT is B1's job.
 *
 * The result is re-parsed through `MemoryCandidate` so the overridden object is
 * guaranteed structurally valid (including the new `proposedByRole` enum).
 */
export function applyIntakeOverrides(
  candidate: MemoryCandidate,
  ctx: IntakeActorContext,
): MemoryCandidate {
  // (1) author ← token identity. Only when the caller is authenticated; dev
  // no-auth / direct-unit intake (no actor) leaves the parsed author untouched.
  const author =
    ctx.actor !== undefined && ctx.actor.length > 0
      ? { type: 'human' as const, id: ctx.actor }
      : candidate.author;

  // (2) trustLevel ← a member's asserted trust is never honored; force lowest.
  const trustLevel = ctx.role === 'member' ? 'untrusted' : candidate.trustLevel;

  // (3) tenantId ← bind to the token's sole tenant when scoped-single; otherwise
  // keep the (guard-validated / unscoped) value.
  const tenantId =
    ctx.tenants !== undefined && ctx.tenants.length === 1 ? ctx.tenants[0]! : candidate.tenantId;

  // (4) prePolicyFlags ← never trust client-set values; reset to server defaults.
  const prePolicyFlags = { potentialSecret: false, lowConfidence: false, duplicateSuspect: false };

  // (5) metadata.proposedByRole ← quarantine marker for B1, stamped from the role.
  const metadata =
    ctx.role !== undefined
      ? { ...candidate.metadata, proposedByRole: ctx.role }
      : candidate.metadata;

  return MemoryCandidate.parse({
    ...candidate,
    author,
    trustLevel,
    tenantId,
    prePolicyFlags,
    metadata,
  });
}

/** Outcome of {@link CandidateService.intake} — safety vs knowledge (created ≠ replay). */
export type IntakeResult = {
  candidate: MemoryCandidate;
  /** First land vs collapsed duplicate (id or content-hash). */
  intake: 'created' | 'already_exists';
};

/**
 * Service layer for memory candidate intake and retrieval.
 * Validates all inputs with Zod before writing to the repository.
 */
export class CandidateService {
  /**
   * @param repo       The candidate store (required).
   * @param auditRepo  The append-only audit store. When present, every accepted
   *                   intake writes a `proposed` provenance receipt (R8). Optional
   *                   so the direct-service unit tests can construct a service
   *                   without an audit sink; the HTTP app always wires it.
   */
  constructor(
    private readonly repo: CandidateRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  /**
   * Validate, server-side-override, and intake a new memory candidate.
   * Computes the content hash, inserts the record, and writes a provenance
   * receipt.
   *
   * Idempotency (jfv.9 + session-stable ids):
   *  1. Same **id** for this tenant → already_exists (covers outbox replay and
   *     session-key retries where distillation text may have changed).
   *  2. Same **content hash** for this tenant → already_exists (content backstop).
   *  3. Else insert + created + proposed receipt.
   *
   * `intake` on the result is knowledge for the caller (safety ≠ first-land proof).
   *
   * @param data  The raw (client-supplied) candidate payload.
   * @param ctx   The bearer-token identity of the caller. Drives the R8 overrides
   *              (author / trustLevel / tenantId / prePolicyFlags / proposedByRole).
   *              Defaults to an empty context (dev no-auth / direct-unit intake),
   *              where only the never-client-trusted fields are reset.
   *
   * @throws a 400 ApiError on invalid (mis-shaped) input.
   * @throws a 422 ApiError when the content violates the no-compensation /
   *   no-PII disclosure rule — the candidate is rejected before it can enter
   *   the inbox (bead `3iu.1`).
   */
  intake(data: unknown, ctx: IntakeActorContext = {}): IntakeResult {
    const parsed = MemoryCandidate.safeParse(data);
    if (!parsed.success) {
      throw badRequest(`Invalid candidate: ${parsed.error.message}`);
    }

    // R8 (bead compile-then-govern-jfv.6.7): never trust the team-mode client for
    // the trust-bearing fields. Re-derive author / trustLevel / tenantId /
    // prePolicyFlags from the SERVER token identity and stamp the quarantine
    // marker BEFORE the disclosure gate + insert, so what is scanned and stored is
    // exactly the server-owned candidate.
    const candidate = applyIntakeOverrides(parsed.data, ctx);

    // Disclosure gate: enforce the no-compensation / no-PII / no-secret rule at
    // the boundary so the API returns a clean 422 (the same gate is also enforced
    // at the repository choke point as the real backstop — see
    // CandidateRepository.insert). The matched value is never echoed back
    // (PII non-leak).
    //
    // R10 fix (010-AT-RISK · bead compile-then-govern-e06.3): the scanned set is
    // derived STRUCTURALLY via `collectFreeTextFields(candidate)` — the exact same
    // walker the repository backstop uses — so every persisted free-text surface
    // (content, title, tenantId, every tag, all ContentMetadata free-text, and the
    // author free-text) is scanned and future schema additions are covered
    // automatically with no manual list to drift.
    const violation = scanDisclosureFields(collectFreeTextFields(candidate));
    if (violation !== null) {
      const kind =
        violation.category === 'pii'
          ? 'PII'
          : violation.category === 'secret'
            ? 'a credential / secret'
            : 'compensation / comp-split';
      throw unprocessable(
        `Candidate rejected: content contains disallowed ${kind} material and cannot enter the governed brain.`,
      );
    }

    // (1) Id-first: session-stable / frozen-outbox replays share the same id even
    // when distillation text differs. Tenant must match so a cross-tenant UUID
    // collision cannot leak another tenant's row.
    const byId = this.repo.findById(candidate.id);
    if (byId !== null) {
      if (byId.tenantId === candidate.tenantId) {
        return { candidate: byId, intake: 'already_exists' };
      }
      // Extremely unlikely with tenant in the UUIDv5 name; refuse rather than
      // insert a colliding primary key or return the wrong tenant's row.
      throw badRequest(
        `Candidate id ${candidate.id} already exists for another tenant; refuse to intake.`,
      );
    }

    const contentHash = computeContentHash(candidate.content);

    // (2) Content-hash backstop (jfv.9): same bytes within tenant collapse even if
    // two different ids were minted (legacy clients / content-derived ids).
    const existing = this.repo.findByContentHashAndTenant(contentHash, candidate.tenantId);
    if (existing !== null) {
      return { candidate: existing, intake: 'already_exists' };
    }

    this.repo.insert(candidate, contentHash);

    // R8 intake receipt: every accepted proposal gets a provenance receipt from
    // byte one — actor + candidateId + contentHash + tenantId — so proposals are
    // never anonymous and B1 has an auditable record before any promotion.
    this.writeIntakeReceipt(candidate, contentHash, ctx);

    return { candidate, intake: 'created' };
  }

  /**
   * Write the append-only `proposed` audit event for an accepted candidate (R8).
   * No-op when no audit sink is wired (direct-service unit tests). Reuses the
   * existing {@link AuditEvent} shape + repo (not a parallel log); `memoryId`
   * carries the candidate's UUID and the id is content-derived so a re-proposed
   * identical candidate yields a reproducible receipt id across clones.
   */
  private writeIntakeReceipt(
    candidate: MemoryCandidate,
    contentHash: string,
    ctx: IntakeActorContext,
  ): void {
    if (this.auditRepo === undefined) return;
    const at = new Date().toISOString();
    const actor =
      ctx.actor !== undefined && ctx.actor.length > 0
        ? { type: 'human' as const, id: ctx.actor }
        : { type: 'system' as const, id: 'intake' };
    const event = AuditEvent.parse({
      id: deriveAuditEventId(candidate.id, 'proposed'),
      action: 'proposed',
      memoryId: candidate.id,
      tenantId: candidate.tenantId,
      actor,
      reason: 'Candidate proposed to the governed inbox',
      details: {
        candidateId: candidate.id,
        contentHash,
        tenantId: candidate.tenantId,
        proposedByRole: ctx.role ?? 'unknown',
        at,
      },
      timestamp: at,
    });
    this.auditRepo.insert(event);
  }

  /**
   * Retrieve a candidate by its UUID.
   * Throws a 404 ApiError if not found.
   */
  getById(id: string): MemoryCandidate {
    const candidate = this.repo.findById(id);
    if (candidate === null) throw notFound(`Candidate ${id} not found`);
    return candidate;
  }

  /**
   * List candidates for a tenant, optionally narrowed to a single lifecycle
   * `status` (e.g. `quarantined` — the queue the agent-review `brain_inbox` tool
   * reads, jfv.8). When no tenantId is provided a 400 is thrown — the API always
   * requires a tenant scope for list operations. An unknown `status` is a 400
   * (closed CandidateStatus vocabulary), never a silent empty result.
   */
  list(tenantId: string | undefined, status?: string): MemoryCandidate[] {
    if (tenantId === undefined || tenantId.length === 0) {
      throw badRequest('tenantId query parameter is required');
    }
    if (status !== undefined && status.length > 0) {
      const parsed = CandidateStatus.safeParse(status);
      if (!parsed.success) {
        throw badRequest(
          `Invalid status filter '${status}' — must be one of: ${CandidateStatus.options.join(', ')}`,
        );
      }
      return this.repo.findByStatus(parsed.data, tenantId);
    }
    return this.repo.findByTenant(tenantId);
  }

  /**
   * Internal helper — check whether a content hash is already stored.
   * Returns null when no match exists.
   */
  findByHash(hash: string): MemoryCandidate | null {
    return this.repo.findByContentHash(hash);
  }
}
