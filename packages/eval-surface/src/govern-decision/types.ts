/**
 * govern-decision eval types — the labeled-case schema and the per-check
 * precision/recall report shapes for the govern-decision efficacy eval.
 *
 * ## Why this exists (010-AT-RISK R5 / R10 · bead compile-then-govern-e06.3 · umbrella #27)
 *
 * The 8 deterministic policy rules are verified-*deterministic* but
 * UNEVALUATED for *correctness*. Determinism is not efficacy: a line-based
 * regex secret-scan is perfectly deterministic AND misses a key split across
 * two lines or a base64-wrapped token. This module carries the labeled
 * adversarial set + the machinery that measures whether the govern decision
 * (the policy pipeline + the two content-classification signals) actually
 * catches what it must.
 *
 * The set is deliberately *versioned* (dataset/v1) and self-describing: each
 * case names the sensitive material class, the surface it is smuggled through,
 * and the govern outcome we assert. False negatives are DATA, not test
 * failures — a documented FN (see the dataset README) is a real gap in the
 * moat, surfaced honestly rather than hidden by weakening a rule.
 */

import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';

import type { DecisionCasesReport } from './decision-types.js';

/**
 * The independent "checks" whose efficacy we score. Each is one detection
 * surface in the govern decision, scored separately so a gap in one (e.g. the
 * line-based secret scanner) is not masked by another (e.g. the boundary
 * disclosure filter).
 */
export type GovernCheck =
  /** The full policy pipeline verdict (`PolicyPipeline.evaluate` → rejected). */
  | 'policy-pipeline'
  /** `scanForSecrets` (claude-runtime) — the signal behind the secret_detection rule. */
  | 'secret-scanner'
  /** `classifyContent` (claude-runtime) — the signal behind the sensitivity_gate rule. */
  | 'content-classifier'
  /** `scanForDisclosure` (common) — the API/repository-boundary disclosure filter. */
  | 'boundary-disclosure';

/** The class of sensitive material a positive case carries (or `none` for a negative). */
export type SensitiveClass =
  | 'secret' // credential / API key / token / private key
  | 'pii' // SSN / DOB / background-check / (email)
  | 'internal-path' // leaked internal filesystem / host / private IP
  | 'none'; // benign — a known-negative

/**
 * The surface / smuggling technique a case exercises. Names the evasion so the
 * report can group false-negatives by *how* they slipped through.
 */
export type Surface =
  | 'inline' // plainly present in a single line of content
  | 'split-multiline' // broken across two lines (defeats the line-based scanner)
  | 'base64-encoded' // wrapped in base64 (no decode step in the scanners)
  | 'hex-encoded' // hex-encoded
  | 'metadata-filepath' // hidden in metadata.filePaths (an "odd field")
  | 'metadata-projectcontext' // hidden in metadata.projectContext
  | 'tenant-spoof' // attacker-set tenantId / author (tenancy-guard evasion)
  | 'benign'; // negative — no sensitive material

/**
 * One labeled adversarial (or benign) case.
 *
 * `expectCaught` is the GROUND TRUTH we assert per check: for a positive case
 * (`sensitiveClass !== 'none'`) at least the checks listed in `expectCaughtBy`
 * SHOULD fire; for a negative case, NO check should fire (a firing check is a
 * false positive). `knownFalseNegativeOf` documents checks we have empirically
 * confirmed MISS this case today — those do not count against precision/recall
 * as surprises, but they ARE reported as documented gaps.
 */
export interface GovernCase {
  /** Stable, human-readable id, e.g. `sec-split-openai-01`. Unique in the set. */
  readonly id: string;
  /** One-line description of what this case smuggles and how. */
  readonly description: string;
  /** The class of sensitive material (or `none` for a known-negative). */
  readonly sensitiveClass: SensitiveClass;
  /** The surface / evasion technique exercised. */
  readonly surface: Surface;
  /**
   * A partial candidate — merged over a valid default by the dataset loader so
   * every case is a real, Zod-valid `MemoryCandidate`. Put the sensitive
   * material on whichever field the surface targets (content, or a metadata
   * field).
   */
  readonly candidate: Partial<MemoryCandidate>;
  /**
   * For a POSITIVE case: the checks that SHOULD catch it (a healthy moat fires
   * at least one of these). Empty for a negative case.
   */
  readonly expectCaughtBy: readonly GovernCheck[];
  /**
   * Checks we have EMPIRICALLY CONFIRMED miss this case today (documented gaps,
   * not surprises). Reported as `documentedFalseNegatives`, never hidden.
   */
  readonly knownFalseNegativeOf?: readonly GovernCheck[];
}

/** Per-check confusion-matrix counts + derived precision / recall / F1. */
export interface CheckMetrics {
  readonly check: GovernCheck;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  /** TP / (TP + FP); 1 when the check never fired (vacuously precise). */
  readonly precision: number;
  /** TP / (TP + FN); 1 when there were no positives to catch. */
  readonly recall: number;
  /** Harmonic mean of precision and recall; 0 when both are 0. */
  readonly f1: number;
}

/** One false-negative the eval measured: a positive case a check failed to fire on. */
export interface FalseNegative {
  readonly caseId: string;
  readonly check: GovernCheck;
  readonly sensitiveClass: SensitiveClass;
  readonly surface: Surface;
  /** True when the case's `knownFalseNegativeOf` already documented this miss. */
  readonly documented: boolean;
}

/** The full govern-decision efficacy report (attached to the EvaluatorResult details as JSON). */
export interface GovernDecisionReport {
  readonly totalCases: number;
  readonly positives: number;
  readonly negatives: number;
  readonly perCheck: readonly CheckMetrics[];
  /** Every false-negative measured, both surprising and documented. */
  readonly falseNegatives: readonly FalseNegative[];
  /** Subset of `falseNegatives` NOT covered by a case's `knownFalseNegativeOf`. */
  readonly undocumentedFalseNegatives: readonly FalseNegative[];
  /**
   * Wave-2 C3: the state-dependent decision section — dedup / contradiction /
   * supersession over the labeled decision set, broken out per check AND per
   * relationship class. Its undocumented false-negatives join the gate.
   */
  readonly decisionCases: DecisionCasesReport;
}
