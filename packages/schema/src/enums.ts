import { z } from 'zod';

export const MemorySource = z.enum(['claude_session', 'manual', 'import', 'mcp']);
export type MemorySource = z.infer<typeof MemorySource>;

export const TrustLevel = z.enum(['high', 'medium', 'low', 'untrusted']);
export type TrustLevel = z.infer<typeof TrustLevel>;

export const MemoryCategory = z.enum([
  'decision',
  'pattern',
  'convention',
  'architecture',
  'troubleshooting',
  'onboarding',
  'reference',
]);
export type MemoryCategory = z.infer<typeof MemoryCategory>;

export const MemoryLifecycleState = z.enum(['active', 'deprecated', 'superseded', 'archived']);
export type MemoryLifecycleState = z.infer<typeof MemoryLifecycleState>;

/**
 * Lifecycle status of a raw memory candidate (B1, bead compile-then-govern-jfv.2.1).
 *
 * Widened from the original `z.literal('inbox')` so the nightly auto-govern sweep
 * can MARK a governed candidate's terminal outcome IN PLACE, never deleting the
 * row. `candidates` is INSERT-ONLY / Tier-A source of truth (005-AT-ARCH §candidates):
 * a remote team-mode `brain_capture` writes the proposal NOWHERE else, so the row
 * is the only copy — retirement is a status MARKER, not a DELETE.
 *
 * Semantics of each value:
 *   - `inbox`       — awaiting governance (the capture default; every write path
 *                     still inserts candidates as `inbox`).
 *   - `promoted`    — the sweep promoted it to a curated memory; row retired, LEFT
 *                     the inbox.
 *   - `duplicate`   — the sweep found its content already curated; row retired.
 *   - `quarantined` — a MEMBER-authored proposal held back from auto-promotion for
 *                     admin digest-approval (the B1 member-quarantine gate); retired
 *                     from the sweep but never silently promoted.
 *   - `flagged` / `rejected` — reserved terminal markers for an ADMIN disposing of a
 *                     candidate the sweep left in the inbox for review. The SWEEP
 *                     itself never sets these (it leaves policy-flagged/rejected
 *                     candidates in `inbox` so the human review queue + the content
 *                     survive); they exist so a later admin action can retire a
 *                     reviewed candidate non-destructively.
 *
 * A closed enum so the disclosure scanner and the repository enum-membership
 * backstop keep treating `status` as closed-vocabulary. Additive/backward-compatible:
 * the DB `status` column is already TEXT with a DEFAULT of `'inbox'`, and every
 * pre-B1 row is `inbox`.
 */
export const CandidateStatus = z.enum([
  'inbox',
  'promoted',
  'rejected',
  'flagged',
  'duplicate',
  'quarantined',
]);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

export const SearchScope = z.enum(['curated', 'all', 'inbox', 'archived']).default('curated');
export type SearchScope = z.infer<typeof SearchScope>;

export const PolicyRuleType = z.enum([
  'secret_detection',
  'dedup_check',
  'relevance_score',
  'content_length',
  'source_trust',
  'tenant_match',
  'sensitivity_gate',
  'content_sanitization',
]);
export type PolicyRuleType = z.infer<typeof PolicyRuleType>;

export const PolicyRuleAction = z.enum(['reject', 'flag', 'approve', 'require_review']);
export type PolicyRuleAction = z.infer<typeof PolicyRuleAction>;

export const AuditAction = z.enum([
  'promoted',
  'demoted',
  'superseded',
  'archived',
  'deleted',
  'searched',
  'exported',
  // Evidence Bundle emission on a curation/promotion cycle (IEP unification
  // thesis, DR-010 Q3). Added for the eval-surface emit path (bead tr08.15/.17/.19).
  'eval-result',
  // Candidate-intake receipt — a proposal enters the pre-governance inbox (R8,
  // bead compile-then-govern-jfv.6.7). Written at intake so every candidate has a
  // provenance receipt (actor + contentHash + tenant) from byte one, before any
  // promotion. `memoryId` on this row is the candidate's UUID.
  'proposed',
  // Batch-level receipt for one auto-govern inbox SWEEP (B1, bead
  // compile-then-govern-jfv.2.1). ONE event per sweep that changed durable state,
  // recording the per-candidate outcomes (candidate ids + outcome, NEVER content)
  // so the drain of the remote-capture inbox is on the append-only chain. Replaces
  // the per-candidate reject receipts the sweep would otherwise emit (which would
  // re-fire every night for a candidate left in the inbox → unbounded chain bloat).
  // `memoryId` is a fixed sweep sentinel UUID (the sweep is not tied to one memory).
  'governed',
]);
export type AuditAction = z.infer<typeof AuditAction>;

/**
 * The role of the token that PROPOSED a candidate (R8, bead
 * compile-then-govern-jfv.6.7). Stamped server-side at intake onto
 * {@link ContentMetadata.proposedByRole} so a downstream auto-govern step (B1)
 * can quarantine member-authored proposals behind admin review rather than
 * auto-promoting them. Mirrors the API token roles (`admin` | `member`); kept in
 * the schema package so it is a durable, persisted vocabulary, not an API-only
 * type. A closed enum so it is treated as closed-vocabulary (never free text).
 */
export const ProposerRole = z.enum(['admin', 'member']);
export type ProposerRole = z.infer<typeof ProposerRole>;

export const Confidence = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof Confidence>;

export const Sensitivity = z.enum(['public', 'internal', 'confidential', 'restricted']);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const AuthorType = z.enum(['human', 'ai', 'system']);
export type AuthorType = z.infer<typeof AuthorType>;

export const LinkType = z.enum([
  'relates_to',
  'supersedes',
  'contradicts',
  'depends_on',
  'part_of',
]);
export type LinkType = z.infer<typeof LinkType>;

export const LinkSource = z.enum(['curator', 'import', 'manual', 'mcp']);
export type LinkSource = z.infer<typeof LinkSource>;

export const ImportBatchStatus = z.enum(['active', 'completed', 'rolled_back']);
export type ImportBatchStatus = z.infer<typeof ImportBatchStatus>;
