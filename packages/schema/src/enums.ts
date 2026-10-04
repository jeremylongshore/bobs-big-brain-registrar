import { z } from 'zod';

// `bulk_import` (5bm.8) marks a whole-machine / large digestion — ICO stamps it
// (with low trust) so a whole-machine mount is distinguishable from a deliberate
// `import` and the source-trust policy can gate it, instead of a 17k-candidate
// digestion looking identical to a curated import (the 2026-07-16 flood).
export const MemorySource = z.enum(['claude_session', 'manual', 'import', 'mcp', 'bulk_import']);
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

// `bulk` (5bm.8) addresses the default-search flood: bulk-digestion reference
// memories route to the non-default `kb-bulk` collection at export, so the
// `curated` default scope no longer surfaces a whole-machine digestion. The
// `bulk` scope is the deliberate way IN to that corpus ('all' also includes it).
export const SearchScope = z
  .enum(['curated', 'all', 'inbox', 'archived', 'bulk'])
  .default('curated');
export type SearchScope = z.infer<typeof SearchScope>;

// `contradiction_check` (GSB blueprint Track E1) surfaces candidates whose
// content overlaps heavily with an existing ACTIVE memory in the same category
// WITHOUT being byte-identical (identical content is `dedup_check`'s job) —
// same-topic-different-content is the shape a contradiction takes before a human
// reads it. v1 is a deterministic token-overlap heuristic, action=flag only; it
// never rejects. Rule values live in `governance_policies.rules_json` (validated
// by this Zod enum) — there is no per-rule-type DB column or CHECK constraint,
// so adding a member here needs no store migration.
export const PolicyRuleType = z.enum([
  'secret_detection',
  'dedup_check',
  'relevance_score',
  'content_length',
  'source_trust',
  'tenant_match',
  'sensitivity_gate',
  'content_sanitization',
  'contradiction_check',
  // `audience_narrowing` (Epic K bead K3, decision `000-docs/053-AT-DECR`) flags
  // a claim whose declared audience is WIDER than its content calls for
  // (credentials -> `owner`, PII -> `admins`). Flag-only: it recommends a
  // narrower audience, it never rejects and never writes one. Added the same way
  // as `contradiction_check` — a Zod member, no store migration.
  'audience_narrowing',
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
  // Governed in-place category correction (5bm.7). A miscategorized memory —
  // category is assigned probabilistically at compile time — is corrected with a
  // receipted audit event carrying {fromCategory, toCategory}, instead of the
  // supersede-and-recreate path that inflated the superseded-churn the audit found.
  'recategorized',
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
  // Receipt for a governed-policy upgrade (5bm.2's migration path): the curator
  // `upgrade-policy` command replaces a store's dormant-rule policy shape with
  // RECOMMENDED_POLICY_RULES. `memoryId` on this row is the POLICY's UUID (the
  // policy row is the mutated durable state); `details` carries the previous
  // rules so the change is reversible from the receipt alone. The audit_events
  // `action` column has no CHECK constraint, so this member needs no migration.
  'policy_upgraded',
  // Governed audience narrowing of an already-promoted memory (Epic K bead K3).
  // `details` carries {from, to} audience tiers; narrowing only (tenant ->
  // admins -> owner). `memoryId` is the narrowed memory.
  'audience_narrowed',
  // Governed redaction (K3 expanded scope, bead compile-then-govern-39z.16): the
  // content of a promoted memory (or of its candidate copy) was REPLACED. The
  // receipt records that it happened, by whom, why, the OLD and NEW content
  // hashes and the secret-pattern names — never the removed text. `memoryId` is
  // the memory's id, or the candidate's id for the candidate-copy receipt.
  'redacted',
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

/**
 * Claim-level audience INSIDE a tenant (Epic K bead K2, decision record
 * `000-docs/053-AT-DECR`). `tenantId` says which tenant owns a memory and
 * `sensitivity` is a coarse global gate; `Audience` says who within the tenant
 * a claim is for. It extends both and replaces neither.
 *
 * Ordered widest to narrowest:
 *   - `tenant` — everyone in the tenant. The DEFAULT: a memory with no audience
 *                behaves exactly as it did before this field existed.
 *   - `admins` — admin and owner callers only.
 *   - `owner`  — the owner only.
 *
 * A closed enum, declared by the capturing caller and validated here; no rule
 * infers it and no model writes it (KR8.1). It rides in `ContentMetadata`, which
 * is persisted in the JSON-validated `metadata_json` column, so adding it needs
 * no store migration and no CHECK constraint. Keep the member list in step with
 * `AUDIENCE_RANK` in `@qmd-team-intent-kb/common` (schema is the base package and
 * cannot be imported there; a store test asserts the two agree).
 */
export const Audience = z.enum(['tenant', 'admins', 'owner']);
export type Audience = z.infer<typeof Audience>;

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
