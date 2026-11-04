/**
 * @qmd-team-intent-kb/eval-surface — QMD's functional eval surface.
 *
 * Evaluators and scoring reports that measure whether the governed brain is doing its job:
 *  - memory-utility       — retrieval recall@k against held-out probes
 *  - dedup-catch-rate     — exact content-hash dedup catch (+ false-positive guard)
 *  - provenance-integrity — per-memory content-hash consistency + audit-chain intactness
 *  - govern-decision      — per-check precision/recall of the deterministic govern
 *                           decision over an adversarial labeled set (is the moat
 *                           merely deterministic, or actually EFFECTIVE?)
 *  - review-agent         — supplied-label class metrics and a read-only frozen-file adapter
 *
 * This package MEASURES. It does not emit or sign Evidence Bundles — the
 * emit wiring (bead tr08.19) now exists at ci/emit-evidence/, which runs the
 * CI eval gates as subprocesses and shapes their verdicts into signed
 * gate-result/v1 bundles for the labs dashboard (subprocess-level v1; an
 * EvaluatorResult-level in-package emitter remains future work). Scoring cores
 * are side-effect-free; the frozen review adapter reads caller-selected files.
 */

export { evaluateMemoryUtility, type MemoryUtilityOptions } from './memory-utility.js';
export { evaluateDedupCatchRate, type DedupCatchRateOptions } from './dedup-catchrate.js';
export {
  evaluateProvenanceIntegrity,
  type ProvenanceIntegrityOptions,
} from './provenance-integrity.js';
export { evaluateGovernDecision, type GovernDecisionOptions } from './govern-decision.js';
export {
  DATASET_VERSION as GOVERN_DATASET_VERSION,
  GOVERN_CASES,
} from './govern-decision/dataset/v1/index.js';
export type {
  GovernCase,
  GovernCheck,
  SensitiveClass,
  Surface,
  CheckMetrics,
  FalseNegative,
  GovernDecisionReport,
} from './govern-decision/types.js';
export {
  evaluateDecisionCases,
  DECISION_PRECISION_FLOORS,
} from './govern-decision/decision-eval.js';
export {
  DECISION_CASES,
  DECISION_DATASET_VERSION,
} from './govern-decision/decision-dataset/v1/index.js';
export type {
  DecisionCase,
  DecisionCheck,
  DecisionClass,
  DecisionCheckMetrics,
  DecisionClassMetrics,
  DecisionFalseNegative,
  DecisionFalsePositive,
  DecisionCasesReport,
} from './govern-decision/decision-types.js';
export {
  evaluateGroundedness,
  GROUNDEDNESS_FLOORS,
  type GroundednessOptions,
} from './groundedness.js';
export { scoreGroundedness, DEFAULT_TOKEN_SUPPORT_THRESHOLD } from './groundedness/scorer.js';
export {
  FIXTURE_VERSION as GROUNDEDNESS_FIXTURE_VERSION,
  GROUNDEDNESS_ITEMS,
} from './groundedness/fixture/v1/index.js';
export { judgeFromEnv, type GroundednessJudge } from './groundedness/llm-judge.js';
export type {
  GroundednessItem,
  GroundednessLabel,
  GroundednessPrediction,
  GroundednessError,
  GroundednessReport,
  Perturbation,
} from './groundedness/types.js';
export type { EvaluatorResult, RetrievalProbe, DedupProbe } from './types.js';
export {
  verifyFrozenReviewDataset,
  scoreFrozenReviewDataset,
  type FrozenReviewOptions,
} from './review-agent-frozen.js';
export {
  scoreReviewJudgments,
  REVIEW_LABELS,
  type ReviewLabel,
  type ReviewJudgmentCase,
  type ReviewJudgmentPrediction,
  type ReviewRecallFloors,
  type ReviewClassMetrics,
} from './review-agent-judgment.js';
export {
  parseOkfFixtureBundle,
  exportGovernedOkfFixture,
  proposeOkfFixtureImport,
} from './okf-fixture/exchange.js';
export {
  parseOkfDocument,
  serializeOkfDocument,
  OKF_SPEC_REVISION,
  OKF_FIXTURE_LIMITS,
} from './okf-fixture/codec.js';
