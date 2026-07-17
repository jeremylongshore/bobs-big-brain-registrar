/**
 * Enum-membership choke point - closed-vocabulary re-assertion at the repository
 * layer (Epic 0 residual hardening, was compile-then-govern-c5k.5).
 *
 * ## Why this exists
 *
 * The disclosure gate ({@link assertDisclosureClean}) scans every persisted
 * free-text surface but deliberately **skips** the enum-constrained fields listed
 * in `ENUM_CONSTRAINED_FIELDS` (`status`, `source`, `category`, `trustLevel`,
 * `confidence`, `sensitivity`, `author.type`). Skipping them is correct ONLY while
 * those fields are guaranteed to hold a value from their closed vocabulary - a
 * legitimate enum member (`convention`, `high`, `human`, ...) carries no PII /
 * secret / comp surface, so scanning it would be a pure false-positive risk.
 *
 * That guarantee normally comes from `MemoryCandidate.parse()` at the boundary.
 * But a **raw `CandidateRepository.insert()` caller** can hand-build a candidate
 * object that never crossed a Zod parse and plant an arbitrary string under an
 * enum-constrained field. Because the disclosure scan skips that field by name, an
 * SSN-shaped / comp-shaped / secret-shaped value smuggled into `category` (or any
 * other enum field) would sail straight through the gate and into durable state.
 *
 * This module closes that gap: it re-asserts enum membership at the same
 * repository choke point. A value that is NOT in its field's closed vocabulary is
 * never legitimate, so it is rejected - and first routed through the disclosure
 * scan so a disclosure-shaped value is caught with its precise category. A VALID
 * enum value is left untouched (no false positive), preserving the skip in
 * {@link collectFreeTextFields}.
 *
 * Like {@link DisclosureRejectedError}, the error carries only the **field name** -
 * never the rejected value - so a smuggled secret is never re-leaked into logs,
 * responses, or the audit trail.
 *
 * @module enum-membership
 */
import {
  MemorySource,
  TrustLevel,
  MemoryCategory,
  MemoryLifecycleState,
  CandidateStatus,
  Confidence,
  Sensitivity,
  AuthorType,
  type MemoryCandidate,
  type CuratedMemory,
} from '@qmd-team-intent-kb/schema';
import { scanForDisclosure, DisclosureRejectedError } from '@qmd-team-intent-kb/common';
import type { z } from 'zod';

/**
 * Error thrown by the repository-layer choke point when an enum-constrained field
 * carries a value outside its closed vocabulary. Carries only the field name -
 * never the rejected value - mirroring {@link DisclosureRejectedError}.
 *
 * This fires only when the off-vocabulary value is NOT itself disclosure-shaped:
 * a disclosure-shaped value (SSN / comp / secret smuggled into an enum field) is
 * caught one step earlier and rejected as {@link DisclosureRejectedError} so the
 * precise category is surfaced.
 */
export class EnumConstraintViolationError extends Error {
  readonly field: string;
  constructor(field: string) {
    // NOTE: message deliberately omits the rejected value (non-leak).
    super(
      `Candidate rejected: field '${field}' carries a value outside its closed vocabulary and cannot enter the governed brain.`,
    );
    this.name = 'EnumConstraintViolationError';
    this.field = field;
  }
}

/**
 * One enum-constrained field to re-assert: its dotted name (for the error) paired
 * with the Zod schema that defines its closed vocabulary and the candidate value.
 */
interface EnumCheck {
  readonly field: string;
  readonly schema: z.ZodTypeAny;
  readonly value: unknown;
}

/**
 * Re-assert closed-vocabulary membership for every enum-constrained field of a
 * candidate, or throw.
 *
 * For each field whose value is present, run the field's Zod enum `.safeParse`. A
 * value in-vocabulary passes silently (and remains correctly skipped by the
 * disclosure scan). A value out-of-vocabulary is never legitimate, so it is:
 *
 *   1. routed through {@link scanForDisclosure} - if it is disclosure-shaped
 *      (SSN / comp / secret), a {@link DisclosureRejectedError} is thrown carrying
 *      the precise category; then
 *   2. otherwise rejected as {@link EnumConstraintViolationError} carrying only the
 *      field name.
 *
 * Optional fields (`metadata.confidence`, `metadata.sensitivity`) are checked only
 * when present - an absent optional is not a violation.
 *
 * Fail-closed and value-non-leaking. Called by `CandidateRepository.insert()`
 * immediately after the disclosure gate and before the row is written.
 *
 * @throws {DisclosureRejectedError} when an off-vocabulary value is disclosure-shaped.
 * @throws {EnumConstraintViolationError} when an off-vocabulary value is otherwise invalid.
 */
export function assertEnumMembership(candidate: MemoryCandidate): void {
  runEnumChecks([
    { field: 'status', schema: CandidateStatus, value: candidate.status },
    { field: 'source', schema: MemorySource, value: candidate.source },
    { field: 'category', schema: MemoryCategory, value: candidate.category },
    { field: 'trustLevel', schema: TrustLevel, value: candidate.trustLevel },
    { field: 'author.type', schema: AuthorType, value: candidate.author?.type },
    {
      field: 'metadata.confidence',
      schema: Confidence,
      value: candidate.metadata?.confidence,
    },
    {
      field: 'metadata.sensitivity',
      schema: Sensitivity,
      value: candidate.metadata?.sensitivity,
    },
  ]);
}

/**
 * Re-assert closed-vocabulary membership for every enum-constrained field of a
 * CURATED MEMORY, or throw. The govern-side twin of {@link assertEnumMembership}
 * (bead qmd-team-intent-kb-5bm.1).
 *
 * `assertEnumMembership` guards the candidates table; nothing guarded
 * `curated_memories` — the highest-trust table. `MemoryRepository.insert/update`
 * bind `category`/`trustLevel`/`sensitivity`/`lifecycle`/`source`/`author.type`
 * raw, and `MemoryRowSchema` validates only on READ, so a raw caller (or a
 * bypassed promotion path) can plant an arbitrary — or disclosure-shaped — string
 * in an enum column of the governed store, where the disclosure scan skips it by
 * name. This closes that gap at the same repository choke point.
 *
 * A CuratedMemory always carries `lifecycle` and `sensitivity` (both required in
 * the schema), and has no `status`/`confidence` (those are candidate-side), so
 * the field set differs from the candidate twin. Same fail-closed, value-non-leaking
 * contract: an off-vocabulary value is routed through the disclosure scan first
 * (precise category if disclosure-shaped) then rejected by field name only.
 *
 * @throws {DisclosureRejectedError} when an off-vocabulary value is disclosure-shaped.
 * @throws {EnumConstraintViolationError} when an off-vocabulary value is otherwise invalid.
 */
export function assertMemoryEnumMembership(memory: CuratedMemory): void {
  runEnumChecks([
    { field: 'source', schema: MemorySource, value: memory.source },
    { field: 'category', schema: MemoryCategory, value: memory.category },
    { field: 'trustLevel', schema: TrustLevel, value: memory.trustLevel },
    { field: 'sensitivity', schema: Sensitivity, value: memory.sensitivity },
    { field: 'lifecycle', schema: MemoryLifecycleState, value: memory.lifecycle },
    { field: 'author.type', schema: AuthorType, value: memory.author?.type },
  ]);
}

/**
 * Run a set of enum-membership checks, fail-closed and value-non-leaking.
 * Shared by the candidate ({@link assertEnumMembership}) and memory
 * ({@link assertMemoryEnumMembership}) choke points.
 */
function runEnumChecks(checks: EnumCheck[]): void {
  for (const { field, schema, value } of checks) {
    // Absent optional enum (confidence / sensitivity) is not a violation.
    if (value === undefined) continue;

    if (schema.safeParse(value).success) continue;

    // Off-vocabulary. If a string, route it through the disclosure scan first so a
    // disclosure-shaped value smuggled into an enum field is caught with its real
    // category instead of the generic enum error.
    if (typeof value === 'string') {
      const violation = scanForDisclosure(value);
      if (violation !== null) {
        throw new DisclosureRejectedError(violation.category);
      }
    }

    throw new EnumConstraintViolationError(field);
  }
}
