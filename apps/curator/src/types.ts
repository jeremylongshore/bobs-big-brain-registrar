import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';

/** Result of curating a single candidate */
export interface CurationResult {
  candidateId: string;
  outcome: 'promoted' | 'rejected' | 'flagged' | 'duplicate';
  /** Set when the candidate was promoted to a curated memory */
  memoryId?: string;
  /** memoryId of the curated memory that was superseded by this promotion */
  supersedes?: string;
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
}
