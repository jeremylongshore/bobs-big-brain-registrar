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
});
export type MemoryCandidate = z.infer<typeof MemoryCandidate>;
