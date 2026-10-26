import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { AuditRepository, CandidateRepository } from '@qmd-team-intent-kb/store';
import { AuditEvent, MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  computeContentHash,
  deriveAuditEventId,
  scanDisclosureFields,
  collectFreeTextFields,
} from '@qmd-team-intent-kb/common';

/** Domain refusal; API callers translate it into their existing HTTP errors. */
export class CandidateIntakeError extends Error {
  constructor(
    public readonly kind: 'invalid' | 'disallowed',
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'CandidateIntakeError';
  }
}

function invalidIntake(message: string): CandidateIntakeError {
  return new CandidateIntakeError('invalid', message);
}

function disallowedIntake(message: string, code?: string): CandidateIntakeError {
  return new CandidateIntakeError('disallowed', message, code);
}

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/**
 * The bearer-token identity of the caller proposing a candidate. Resolved by the
 * auth middleware onto the request (`request.actor` / `request.role` /
 * `request.tenants`) and threaded into {@link CandidateIntake.intake} so the
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
  role?: 'admin' | 'member';
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

/**
 * Channels a team-mode capture may CLAIM in `origin.channel` when no
 * deployment-specific allowlist is configured (H3 — env `TEAMKB_ALLOWED_CHANNELS`,
 * comma-separated, overrides). The shipped capture surfaces:
 *
 *  - `team-mcp`  — the plugin's team-mode `brain_capture` proxy.
 *  - `local-mcp` — the plugin's local-mode capture (spool path; listed so a
 *    locally-minted candidate replayed through the API is not misclassified as
 *    unrecognized).
 *
 * `unattested` is deliberately ABSENT: it is receipt vocabulary for candidates
 * carrying NO origin, never a claimable channel. A candidate with no `origin`
 * object skips this check entirely (backward compatibility with pre-H1
 * clients); only an EXPLICIT claim of an unknown channel is refused, with the
 * stable 422 code `unrecognized_channel`.
 */
export const DEFAULT_ALLOWED_ORIGIN_CHANNELS: readonly string[] = ['team-mcp', 'local-mcp'];

/** Outcome of {@link CandidateIntake.intake} — safety vs knowledge (created ≠ replay). */
export type IntakeResult = {
  candidate: MemoryCandidate;
  /** First land vs collapsed duplicate (id or content-hash). */
  intake: 'created' | 'already_exists';
};

/**
 * Shared candidate intake boundary. The caller establishes identity and tenant authority.
 * Validates all inputs with Zod before writing to the repository.
 */
export class CandidateIntake {
  /**
   * @param repo       The candidate store (required).
   * @param auditRepo  The append-only audit store. When present, every accepted
   *                   intake writes a `proposed` provenance receipt (R8). Optional
   *                   so the direct-service unit tests can construct a service
   *                   without an audit sink; the HTTP app always wires it.
   */
  /**
   * @param allowedChannels  Origin channels a capture may claim (H3). Defaults
   *                         to {@link DEFAULT_ALLOWED_ORIGIN_CHANNELS};
   *                         deployments override via `TEAMKB_ALLOWED_CHANNELS`
   *                         (wired in main.ts / buildApp).
   */
  constructor(
    private readonly repo: CandidateRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly allowedChannels: readonly string[] = DEFAULT_ALLOWED_ORIGIN_CHANNELS,
  ) {}

  /**
   * Validate, server-side-override, and intake a new memory candidate.
   * Audited callers commit the computed content hash, candidate and proposal
   * receipt together. Optional no-audit construction preserves legacy direct
   * service compatibility and provides no receipt or atomic-write guarantee.
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
   * @throws CandidateIntakeError with kind invalid on malformed input.
   * @throws CandidateIntakeError with kind disallowed for no-compensation /
   *   no-PII disclosure rule — the candidate is rejected before it can enter
   *   the inbox (bead `3iu.1`).
   */
  intake(data: unknown, ctx: IntakeActorContext = {}): IntakeResult {
    // The unaudited compatibility surface is used by direct service callers.
    // Recovery uses intakeCandidate below, which always supplies an audit sink.
    if (this.auditRepo === undefined) return this.intakeValidated(data, ctx);
    const connection = this.repo.connection;
    if (this.auditRepo.connection !== connection) {
      throw new Error('Audited intake requires one shared database connection');
    }
    return connection.transaction(() => this.intakeValidated(data, ctx)).immediate();
  }

  private intakeValidated(data: unknown, ctx: IntakeActorContext): IntakeResult {
    const parsed = MemoryCandidate.safeParse(data);
    if (!parsed.success) {
      throw invalidIntake(`Invalid candidate: ${parsed.error.message}`);
    }

    // Authorized-channel gate (GSB Wave-2 H3): a capture that CLAIMS an origin
    // channel this deployment does not recognize is refused with a distinct,
    // stable 422 code before any override/scan/insert work. A candidate with NO
    // `origin` skips this entirely (pre-H1 clients stay compatible; it governs
    // later as `unattested`). Note this checks the channel CLAIM only — the
    // token HMAC is verified at promotion time, where the govern path holds the
    // installation secret.
    if (
      parsed.data.origin !== undefined &&
      !this.allowedChannels.includes(parsed.data.origin.channel)
    ) {
      throw disallowedIntake(
        `Candidate rejected: origin channel '${parsed.data.origin.channel}' is not an authorized capture channel on this deployment.`,
        'unrecognized_channel',
      );
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
      throw disallowedIntake(
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
      throw invalidIntake(
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

    // Redacted text must not come back (K3). The repository insert refuses it
    // too; checking here turns that into a 422 rather than an unhandled throw.
    if (this.repo.isRedactedContent(candidate.content, candidate.tenantId)) {
      throw disallowedIntake(
        'Candidate rejected: this exact content was removed by a governed redaction and cannot re-enter the governed brain.',
        'redacted_content',
      );
    }

    this.repo.insert(candidate, contentHash);

    // R8 intake receipt: every accepted proposal gets a provenance receipt from
    // byte one — actor + candidateId + contentHash + tenantId — so proposals are
    // never anonymous and B1 has an auditable record before any promotion.
    const receipt = this.writeIntakeReceipt(candidate, contentHash, ctx);
    if (this.auditRepo !== undefined) {
      const stored = this.repo.findById(candidate.id);
      const hash = this.repo.connection
        .prepare('SELECT content_hash FROM candidates WHERE id = ?')
        .get(candidate.id) as { content_hash: string } | undefined;
      if (
        !isDeepStrictEqual(jsonValue(stored), jsonValue(candidate)) ||
        hash?.content_hash !== contentHash
      ) {
        throw new Error('Candidate intake did not retain the canonical candidate');
      }
      const actual = this.auditRepo
        .findByMemoryAndTenant(candidate.id, candidate.tenantId)
        .find((event) => event.id === receipt?.id);
      if (receipt === undefined || !isDeepStrictEqual(actual, receipt)) {
        throw new Error('Candidate intake did not retain its canonical proposal receipt');
      }
    }

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
  ): AuditEvent | undefined {
    if (this.auditRepo === undefined) return undefined;
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
    return event;
  }
}

/** Canonical audited intake; caller establishes actor and tenant authority.
 * No policy decision, origin-HMAC validation, filesystem lock or anchor here.
 * Replays return the stored identity without fabricating a historical receipt.
 */
export function intakeCandidate(
  data: unknown,
  connection: Database.Database,
  ctx: IntakeActorContext = {},
  allowedChannels: readonly string[] = DEFAULT_ALLOWED_ORIGIN_CHANNELS,
): IntakeResult {
  return new CandidateIntake(
    new CandidateRepository(connection),
    new AuditRepository(connection),
    allowedChannels,
  ).intake(data, ctx);
}
