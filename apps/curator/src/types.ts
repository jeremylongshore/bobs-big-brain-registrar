import type { PipelineResult, SupersessionMatch } from '@qmd-team-intent-kb/policy-engine';
import type { BrainignoreRuleset } from './import-exclusion/brainignore.js';

/** Dry-run / blocked supersession outcome attached to a {@link CurationResult}. */
export interface SupersessionReport {
  /** `report` = report-mode (nothing applied); `blocked` = a guard refused to apply it. */
  status: 'report' | 'blocked';
  /** The memories that would be (report) retired. Empty when blocked. */
  wouldSupersede: SupersessionMatch[];
  /** Why a guard blocked it (per-promotion cap or per-run budget). */
  blockedReason?: string;
  /** How many memories a blocked plan would have retired. */
  blockedCount?: number;
}

/** Result of curating a single candidate */
export interface CurationResult {
  candidateId: string;
  outcome: 'promoted' | 'rejected' | 'flagged' | 'duplicate';
  /** Set when the candidate was promoted to a curated memory */
  memoryId?: string;
  /** memoryId of the curated memory that was superseded by this promotion */
  supersedes?: string;
  /** Every memoryId retired by this promotion (subject-keyed supersession can retire several). */
  supersededIds?: string[];
  /**
   * What supersession WOULD have done, populated only when
   * `CuratorConfig.supersessionMode === 'report'` (nothing was retired) or when
   * a guard blocked the supersession (cap exceeded). Absent when no supersession
   * was planned.
   */
  supersessionReport?: SupersessionReport;
  pipelineResult?: PipelineResult;
  reason: string;
}

/** Aggregate result of a batch curation run */
export interface CurationBatchResult {
  processed: number;
  promoted: number;
  rejected: number;
  flagged: number;
  duplicates: number;
  results: CurationResult[];
}

/** Configuration for a Curator instance */
export interface CuratorConfig {
  tenantId: string;
  /** When true, all pipeline logic runs but nothing is persisted to the database */
  dryRun?: boolean;
  /**
   * Jaccard similarity threshold for title-based supersession detection.
   * Range 0.0–1.0. Default 0.6.
   */
  supersessionThreshold?: number;
  /**
   * `apply` (default) retires superseded memories as part of promotion.
   * `report` runs the full deterministic detection but retires NOTHING; each
   * promoted result carries `supersessionReport.wouldSupersede` instead. Use it
   * to preview a subject-key backfill before opting in to `apply`.
   */
  supersessionMode?: 'apply' | 'report';
  /**
   * Per-promotion cap on subject-key retirements (default
   * `DEFAULT_MAX_SUPERSEDES_PER_PROMOTION`). A subject matching more memories
   * than this retires NOTHING and surfaces `supersessionReport.status ===
   * 'blocked'`. Raising it is the explicit opt-in for a legitimately broad
   * subject.
   */
  maxSupersedesPerPromotion?: number;
  /**
   * Per-Curator-instance (i.e. per run) budget of subject-key retirements
   * across ALL promotions (default 200). When exhausted, further subject-key
   * supersession is blocked (the memory still promotes) so one run can never
   * retire thousands of rows without an explicit, larger opt-in.
   */
  maxSupersedesPerRun?: number;
  /**
   * When true, a rejected/flagged candidate does NOT get its own per-candidate
   * `reject` audit receipt — only the batch outcome is returned in the
   * {@link CurationResult} (B1, bead compile-then-govern-jfv.2.1). Promotions still
   * write their full durable state + `promoted` receipt.
   *
   * The auto-govern inbox sweep sets this. Rationale: the sweep LEAVES
   * policy-flagged/rejected candidates in the inbox for human review (it never
   * retires them), so they are re-evaluated on EVERY nightly run. A per-candidate
   * reject receipt (a fresh random-id audit event) each night would grow the audit
   * chain without bound — the exact "second run is a no-op" idempotency the sweep
   * must guarantee. The sweep instead emits ONE batch-level `governed` receipt (in
   * runGovern) recording the outcomes, and only when durable state actually
   * changed. Defaults to false (the daemon / CLI keep per-candidate reject
   * receipts).
   */
  suppressRejectionReceipts?: boolean;
  /**
   * Per-installation origin secret used to verify candidate `origin`
   * attestations before promotion (GSB Wave-2 H1 — see `origin/origin-gate.ts`).
   * When unset, UNATTESTED candidates still govern normally (backward
   * compatibility), but a candidate that CLAIMS an origin is rejected as
   * `origin_token_unverifiable` (fail-closed: a claimed attestation we cannot
   * check must not promote as if it verified). Callers on an installation with
   * a brain base dir should resolve it via `loadOrCreateOriginSecret()`.
   */
  originSecret?: string;
  /**
   * Brainignore ruleset for the import exclusion gate (bead 5kw.1 — see
   * `import-exclusion/`). When unset, the COMMITTED DEFAULT ruleset applies —
   * the gate is always on for import-source candidates; wiring is only needed
   * to honor the per-brain override file (`loadBrainignoreRuleset()`), never
   * to enable the protection.
   */
  importExclusions?: BrainignoreRuleset;
}
