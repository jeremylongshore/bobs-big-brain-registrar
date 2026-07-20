import { z } from 'zod';
import { CandidateStatus, MemoryCategory, MemorySource, TrustLevel } from './enums.js';
import { Author, ContentMetadata, IsoDatetime, NonEmptyString, TenantId, Uuid } from './common.js';

/** Pre-policy flags raised during capture */
export const PrePolicyFlags = z.object({
  potentialSecret: z.boolean().default(false),
  lowConfidence: z.boolean().default(false),
  duplicateSuspect: z.boolean().default(false),
});
export type PrePolicyFlags = z.infer<typeof PrePolicyFlags>;

/**
 * The spool-candidate schema version INTKB accepts (5bm.6). ICO's emitter stamps
 * `schemaVersion: '1'` on every spool line; a future ICO v2 sets `'2'`. Pinning
 * the literal here means a v2 line FAILS `MemoryCandidate.safeParse` and is
 * rejected, rather than being silently stripped by `z.object()` and ingested as
 * v1 with its new fields dropped. The `.default` keeps constructors and legacy
 * lines that omit the field valid at v1.
 */
export const MEMORY_CANDIDATE_SCHEMA_VERSION = '1' as const;

/**
 * Capture channel identifier carried inside {@link CandidateOrigin} (H1/H3,
 * write-time provenance). Tag-shaped (lowercase kebab) and bounded so it can
 * never carry free-form prose; the team API additionally checks the value
 * against its authorized-channel allowlist at intake (H3). This is a SHAPE
 * constraint only — which channels are *authorized* is deployment config, not
 * schema.
 */
export const OriginChannel = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(64);
export type OriginChannel = z.infer<typeof OriginChannel>;

/**
 * Write-time provenance attestation (H1). Minted by the CAPTURING client at
 * capture time: `tokenHmac` is an HMAC-SHA256 (lowercase hex) over the
 * candidate's identity tuple `(id, tenantId, capturedAt)` keyed by the
 * per-installation origin secret (see `@qmd-team-intent-kb/common`
 * origin-token utilities). The govern/promotion path re-derives the HMAC and
 * rejects a candidate whose token does not verify (`origin_token_invalid`) —
 * a receipted policy-style reject, never a crash.
 *
 * OPTIONAL by design (v1 backward compatibility): every pre-H1 spool line and
 * legacy capture carries no `origin`, and hard-requiring it would orphan all
 * of them. An origin-less candidate is accepted and its promotion receipt
 * records channel `unattested`; only a PRESENT-but-invalid origin rejects.
 *
 * Deliberately NOT part of any id derivation: the spool candidate id stays
 * `uuidV5(namespace, workspaceId\0relPath\0bodySha256)` (content-only inputs),
 * so adding/removing `origin` never changes `id` and content-stable dedupe is
 * preserved.
 */
export const CandidateOrigin = z
  .object({
    /** HMAC-SHA256 of (id, tenantId, capturedAt) under the installation secret — lowercase hex. */
    tokenHmac: z.string().regex(/^[0-9a-f]{64}$/),
    /** Which capture surface minted this (e.g. `local-mcp`, `team-mcp`). Self-asserted in local mode (H4). */
    channel: OriginChannel,
    /** When the token was minted (ISO-8601). Informational; the HMAC binds `capturedAt`, not this. */
    mintedAt: IsoDatetime,
  })
  // `unattested` is RECEIPT vocabulary — the promotion receipt's marker for a
  // candidate that carries NO origin at all. Enforcing the reservation here in
  // the schema (not just by allowlist convention) means a client can never
  // CLAIM it, and even an operator who mistakenly adds `unattested` to the
  // intake allowlist cannot make such a claim parse: the candidate is refused
  // at the schema boundary before any allowlist logic runs. Keep the literal
  // in sync with `UNATTESTED_CHANNEL` in `@qmd-team-intent-kb/common`
  // (schema is the base package and cannot import common).
  .refine((o) => o.channel !== 'unattested', {
    message:
      "origin.channel 'unattested' is reserved receipt vocabulary for candidates without an origin — a client cannot claim it",
    path: ['channel'],
  });
export type CandidateOrigin = z.infer<typeof CandidateOrigin>;

/** A raw memory proposal captured from a Claude Code session, before governance */
export const MemoryCandidate = z.object({
  schemaVersion: z
    .literal(MEMORY_CANDIDATE_SCHEMA_VERSION)
    .default(MEMORY_CANDIDATE_SCHEMA_VERSION),
  id: Uuid,
  status: CandidateStatus,
  source: MemorySource,
  content: NonEmptyString,
  title: NonEmptyString,
  category: MemoryCategory,
  trustLevel: TrustLevel.default('medium'),
  author: Author,
  tenantId: TenantId,
  metadata: ContentMetadata.default({ filePaths: [], tags: [] }),
  prePolicyFlags: PrePolicyFlags.default({
    potentialSecret: false,
    lowConfidence: false,
    duplicateSuspect: false,
  }),
  capturedAt: IsoDatetime,
  /** Optional write-time provenance attestation (H1) — verified before promotion when present. */
  origin: CandidateOrigin.optional(),
});
export type MemoryCandidate = z.infer<typeof MemoryCandidate>;
