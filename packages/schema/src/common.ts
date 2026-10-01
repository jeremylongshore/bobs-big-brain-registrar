import { z } from 'zod';
import { AuthorType, Confidence, ProposerRole, Sensitivity } from './enums.js';

/** UUID v4 string */
export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

/** SHA-256 hex hash (64 lowercase hex characters) */
export const Sha256Hash = z.string().regex(/^[a-f0-9]{64}$/, 'Must be a valid SHA-256 hex hash');
export type Sha256Hash = z.infer<typeof Sha256Hash>;

/** ISO 8601 datetime string */
export const IsoDatetime = z.string().datetime();
export type IsoDatetime = z.infer<typeof IsoDatetime>;

/** Non-empty trimmed string */
export const NonEmptyString = z.string().trim().min(1);
export type NonEmptyString = z.infer<typeof NonEmptyString>;

/** Semantic version string — full SemVer 2.0.0 (e.g., 1.2.3, 1.0.0-alpha.1, 1.0.0+build.123) */
export const SemVer = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    'Must be a valid semver string',
  );
export type SemVer = z.infer<typeof SemVer>;

/** Tag — lowercase alphanumeric with hyphens */
export const Tag = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be a lowercase tag');
export type Tag = z.infer<typeof Tag>;

/**
 * Subject key — the stable identity of "what this memory is about" (the
 * `(s,r,o)` head: the subject `s`). Supersession keys on SUBJECT identity, not
 * title-token overlap: a newer memory about the same subject retires an older
 * one. Lowercase dot/hyphen-separated slug, length-bounded so it is a pure
 * identifier that can never carry free-form prose (compared by exact
 * equality, never fuzzily).
 */
export const SubjectKey = z
  .string()
  .max(96)
  .regex(
    /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/,
    'Must be a lowercase dot/hyphen slug (e.g. "hosting.gcp")',
  );
export type SubjectKey = z.infer<typeof SubjectKey>;

/** Author metadata */
export const Author = z.object({
  type: AuthorType,
  id: NonEmptyString,
  name: NonEmptyString.optional(),
});
export type Author = z.infer<typeof Author>;

/** Tenant identifier — scoped project or team boundary */
export const TenantId = NonEmptyString;
export type TenantId = z.infer<typeof TenantId>;

/** Metadata about the content's origin and context */
export const ContentMetadata = z.object({
  filePaths: z.array(z.string()).default([]),
  language: z.string().optional(),
  projectContext: z.string().optional(),
  sessionId: z.string().optional(),
  repoUrl: z.string().optional(),
  branch: z.string().optional(),
  confidence: Confidence.optional(),
  sensitivity: Sensitivity.optional(),
  tags: z.array(Tag).default([]),
  /**
   * Explicit subject keys this memory is about (see {@link SubjectKey}).
   * Optional: absent on every legacy record, which then falls back to the
   * same-category title-similarity near-duplicate path. Bounded so a candidate
   * cannot declare an unbounded fan-out of subjects.
   */
  subjects: z.array(SubjectKey).max(8).optional(),
  /**
   * The role of the token that proposed this candidate, stamped server-side at
   * intake (R8, bead compile-then-govern-jfv.6.7). Never client-supplied — the
   * intake path overwrites it from the bearer-token identity so a member cannot
   * masquerade as an admin-authored proposal. A closed enum (`admin` | `member`),
   * so the disclosure scanner and the enum-membership backstop treat it as
   * closed-vocabulary. Optional/absent on legacy records and non-token (dev)
   * intake; present on every token-authenticated proposal. Flows through
   * promotion onto the curated memory so a later auto-govern step (B1) can
   * quarantine member-authored content behind admin review.
   */
  proposedByRole: ProposerRole.optional(),
});
export type ContentMetadata = z.infer<typeof ContentMetadata>;
