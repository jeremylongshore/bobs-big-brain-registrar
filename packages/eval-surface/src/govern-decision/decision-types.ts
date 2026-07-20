/**
 * govern-decision DECISION-CASE types — the labeled schema for the Wave-2 C3
 * extension: does the govern decision catch candidates that DUPLICATE,
 * CONTRADICT, or SUPERSEDE existing active memories?
 *
 * ## Why (GSB blueprint Wave-2 C3 · umbrella epic)
 *
 * The original adversarial set (dataset/v1) measures the SENSITIVE-MATERIAL
 * surfaces (secrets / PII / paths). It never exercises the three decisions
 * that need EXISTING STATE to fire: `dedup_check` (exact content-hash),
 * `contradiction_check` (the Phase-1 flag-only rule), and the supersession
 * detector. Those are the govern decisions most likely to rot silently —
 * they pass vacuously whenever the context wiring breaks (no hashes, no
 * active-memory lookup), which is exactly the failure this labeled set makes
 * measurable.
 *
 * Cases are wired through the REAL machinery: a real in-memory store
 * (`createTestDatabase` + `MemoryRepository`), the real `PolicyPipeline` with
 * the production `dedup_check` + `contradiction_check` rules, and the real
 * `detectSupersession` (now exported from policy-engine). No mocks of the
 * decision under test.
 *
 * Labels follow the same honesty contract as the main set: `expectFiredBy` is
 * empirical ground truth; `knownFalseNegativeOf` documents measured gaps
 * (reworded duplicates beat exact-hash dedup; low-overlap or cross-category
 * contradictions beat the token-overlap heuristic; reworded titles beat
 * title-Jaccard supersession). Documented gaps are reported, never hidden;
 * an UNDOCUMENTED miss fails the eval closed.
 */

import type { MemoryCategory } from '@qmd-team-intent-kb/schema';

/** The three state-dependent decision surfaces this extension scores. */
export type DecisionCheck =
  /** The production `dedup_check` rule (exact SHA-256 content hash) inside the pipeline. */
  | 'dedup-rule'
  /** The production Phase-1 `contradiction_check` rule (token-overlap flag) inside the pipeline. */
  | 'contradiction-rule'
  /** `detectSupersession` (policy-engine) — title-Jaccard supersession detection. */
  | 'supersession-detector';

/** The relationship class a decision case exercises (or `clean` for a negative). */
export type DecisionClass =
  | 'duplicate' // candidate duplicates an existing active memory
  | 'contradiction' // candidate contradicts an existing active memory
  | 'supersession' // candidate supersedes an existing active memory
  | 'clean'; // benign — no meaningful relationship to existing actives

/** A minimal existing ACTIVE memory the case seeds into the real store. */
export interface ExistingActive {
  readonly title: string;
  readonly content: string;
  readonly category: MemoryCategory;
}

/** One labeled decision case. */
export interface DecisionCase {
  /** Stable, human-readable id, e.g. `dup-exact-01`. Unique in the set. */
  readonly id: string;
  /** One-line description of the relationship and how it is (or isn't) caught. */
  readonly description: string;
  /** The relationship class (or `clean` for a known-negative). */
  readonly decisionClass: DecisionClass;
  /** The incoming candidate's distinguishing fields. */
  readonly candidate: {
    readonly title: string;
    readonly content: string;
    readonly category: MemoryCategory;
  };
  /** Active memories seeded into the store BEFORE the candidate is evaluated. */
  readonly existingActives: readonly ExistingActive[];
  /**
   * For a positive case: the checks that SHOULD fire. Empty for `clean` cases
   * and for positives that are wholly documented gaps.
   */
  readonly expectFiredBy: readonly DecisionCheck[];
  /** Checks EMPIRICALLY CONFIRMED to miss this case today (documented gaps). */
  readonly knownFalseNegativeOf?: readonly DecisionCheck[];
  /**
   * For a `clean` case: checks EMPIRICALLY CONFIRMED to FIRE on it today — a
   * KNOWN false positive (e.g. the token-overlap contradiction heuristic
   * firing on a compatible restatement). Known FPs still count as false
   * positives in the confusion matrix (precision honestly drops), but they
   * are reported as documented, never as a surprise; the gate holds them via
   * the measured-then-committed per-check precision floors.
   */
  readonly knownFalsePositiveOf?: readonly DecisionCheck[];
}

/** Per-check confusion-matrix counts for the decision checks. */
export interface DecisionCheckMetrics {
  readonly check: DecisionCheck;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

/** Per-class recall breakout: how much of each relationship class is caught. */
export interface DecisionClassMetrics {
  readonly decisionClass: Exclude<DecisionClass, 'clean'>;
  /** Number of (case, expected-or-documented check) pairs in this class. */
  readonly scoredPairs: number;
  /** Pairs where the check fired. */
  readonly caught: number;
  /** caught / scoredPairs (1 when there is nothing to catch). */
  readonly catchRate: number;
  /** Pairs whose miss is already documented in `knownFalseNegativeOf`. */
  readonly documentedMisses: number;
}

/** One decision-case false negative. */
export interface DecisionFalseNegative {
  readonly caseId: string;
  readonly check: DecisionCheck;
  readonly decisionClass: DecisionClass;
  readonly documented: boolean;
}

/** One decision-case false positive: a check that fired on a `clean` case. */
export interface DecisionFalsePositive {
  readonly caseId: string;
  readonly check: DecisionCheck;
  /** True when the case's `knownFalsePositiveOf` already documents this firing. */
  readonly documented: boolean;
}

/** The decision-case section of the govern-decision report. */
export interface DecisionCasesReport {
  readonly datasetVersion: string;
  readonly totalCases: number;
  readonly positives: number;
  readonly negatives: number;
  readonly perCheck: readonly DecisionCheckMetrics[];
  readonly perClass: readonly DecisionClassMetrics[];
  readonly falseNegatives: readonly DecisionFalseNegative[];
  readonly undocumentedFalseNegatives: readonly DecisionFalseNegative[];
  /** Every firing on a clean case — documented (known FP) or a surprise. */
  readonly falsePositives: readonly DecisionFalsePositive[];
  /** Subset of `falsePositives` covered by a case's `knownFalsePositiveOf`. */
  readonly knownFalsePositives: readonly DecisionFalsePositive[];
}
