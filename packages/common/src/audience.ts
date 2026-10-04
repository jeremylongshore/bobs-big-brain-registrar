/**
 * Claim-level audience enforcement (Epic K bead K2, decision record
 * `000-docs/053-AT-DECR`).
 *
 * `tenantId` isolates tenants and `sensitivity` is a coarse global gate; the
 * audience says who INSIDE a tenant a claim is for. These predicates are the
 * single deterministic decision for every read path and for the exporter. They
 * are pure, take plain strings (this package cannot import the schema package)
 * and fail CLOSED: a value they do not recognize never widens visibility.
 *
 * Placement (KR8.1): the audience value is declared at capture, validated by the
 * closed `Audience` Zod enum in `@qmd-team-intent-kb/schema`, and read only by
 * these functions. No model decides or writes it.
 */

/** Audience of a memory that declares none: tenant-wide, exactly pre-K2 behavior. */
export const DEFAULT_AUDIENCE = 'tenant';

/**
 * Audience tiers ranked widest (0) to narrowest. Must list exactly the members of
 * the schema's `Audience` enum (asserted by a store test, which can see both).
 */
export const AUDIENCE_RANK: Readonly<Record<string, number>> = Object.freeze({
  tenant: 0,
  admins: 1,
  owner: 2,
});

/**
 * The narrowest audience tier each reader role is cleared for. A reader sees a
 * memory when the memory's tier is at or below the reader's clearance.
 */
export const READER_ROLE_CLEARANCE: Readonly<Record<string, number>> = Object.freeze({
  member: 0,
  admin: 1,
  owner: 2,
});

/** A caller's read standing: API token role, plus `owner` for the tenant owner. */
export type ReaderRole = 'member' | 'admin' | 'owner';

/** The audience a memory effectively has: its declared value, or the default. */
export function resolveAudience(audience: string | null | undefined): string {
  return audience === undefined || audience === null ? DEFAULT_AUDIENCE : audience;
}

/**
 * True when a reader with `role` may be shown a memory with `audience`.
 *
 * | audience \ role | member | admin | owner |
 * | --------------- | ------ | ----- | ----- |
 * | (absent)/tenant | yes    | yes   | yes   |
 * | admins          | no     | yes   | yes   |
 * | owner           | no     | no    | yes   |
 *
 * Fail-closed: an unrecognized audience value is hidden from every role (the
 * owner included — an unknown tier is a data fault to fix, not to read around),
 * and an unrecognized or absent role sees nothing.
 */
export function isAudienceVisibleToRole(
  audience: string | null | undefined,
  role: string | null | undefined,
): boolean {
  if (role === undefined || role === null) return false;
  if (!Object.hasOwn(READER_ROLE_CLEARANCE, role)) return false;
  const effective = resolveAudience(audience);
  if (!Object.hasOwn(AUDIENCE_RANK, effective)) return false;
  return AUDIENCE_RANK[effective]! <= READER_ROLE_CLEARANCE[role]!;
}

/**
 * True when a memory with `audience` may be written to the shared export tree
 * (and so into the shared search index). Only tenant-wide memories qualify: the
 * tree has one audience — everyone in the tenant — so anything narrower, or any
 * value not recognized, stays out until per-audience indexes exist.
 */
export function isExportableAudience(audience: string | null | undefined): boolean {
  return resolveAudience(audience) === DEFAULT_AUDIENCE;
}

/**
 * Map an API token's role and owner flag to a {@link ReaderRole}.
 *
 * `owner` standing requires BOTH the admin role and an explicit owner flag, so
 * an owner flag on a member token never raises it. Anything that is not exactly
 * `admin` reads as `member` (least privilege).
 */
export function readerRoleFor(role: string | null | undefined, owner: boolean): ReaderRole {
  if (role !== 'admin') return 'member';
  return owner ? 'owner' : 'admin';
}

/** Why a requested audience change is not a legal narrowing. */
export type AudienceNarrowingRefusal = 'widening' | 'same' | 'unknown_from' | 'unknown_to';

/** Result of {@link validateAudienceNarrowing}. */
export type AudienceNarrowingValidation =
  | { valid: true; from: string; to: string }
  | { valid: false; code: AudienceNarrowingRefusal; error: string };

/**
 * True when `to` is STRICTLY narrower than `from` (K3). An absent `from` is the
 * default (`tenant`). Fail-closed: an unrecognized value on either side is never
 * a narrowing.
 */
export function isAudienceNarrowing(from: string | null | undefined, to: string): boolean {
  return validateAudienceNarrowing(from, to).valid;
}

/**
 * Validate a governed audience change (Epic K bead K3). The only legal move is
 * toward a STRICTLY narrower tier: `tenant` -> `admins` -> `owner` (skipping a
 * tier is allowed). Everything else is refused with a reason:
 *
 *   - `widening`     — `to` is wider than `from`. Widening is bead K4
 *                      (widening-with-redaction) and is not available here.
 *   - `same`         — `to` equals the current audience (nothing to do).
 *   - `unknown_from` — the stored audience is not a known tier: a data fault to
 *                      fix at source, never something to narrow "from".
 *   - `unknown_to`   — the requested tier is not a known audience.
 *
 * Pure, takes plain strings, and is the single decision used by the curator CLI
 * and the API route.
 */
export function validateAudienceNarrowing(
  from: string | null | undefined,
  to: string | null | undefined,
): AudienceNarrowingValidation {
  const current = resolveAudience(from);
  if (!Object.hasOwn(AUDIENCE_RANK, current)) {
    return {
      valid: false,
      code: 'unknown_from',
      error: `Current audience "${current}" is not a known tier; fix the record before narrowing it`,
    };
  }
  if (to === undefined || to === null || !Object.hasOwn(AUDIENCE_RANK, to)) {
    return {
      valid: false,
      code: 'unknown_to',
      error: `Unknown audience "${String(to)}" (expected one of: ${Object.keys(AUDIENCE_RANK).join(', ')})`,
    };
  }
  const fromRank = AUDIENCE_RANK[current]!;
  const toRank = AUDIENCE_RANK[to]!;
  if (toRank === fromRank) {
    return { valid: false, code: 'same', error: `Audience is already "${current}"` };
  }
  if (toRank < fromRank) {
    return {
      valid: false,
      code: 'widening',
      error:
        `Refusing to widen audience "${current}" -> "${to}": this operation only narrows ` +
        `(tenant -> admins -> owner). Widening is a separate governed path (K4) and is not available.`,
    };
  }
  return { valid: true, from: current, to };
}
