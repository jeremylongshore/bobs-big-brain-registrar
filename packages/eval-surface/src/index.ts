/**
 * @qmd-team-intent-kb/eval-surface — QMD's functional eval surface.
 *
 * Pure evaluators that measure whether the governed brain is doing its job,
 * each returning an Evidence-Bundle-friendly EvaluatorResult:
 *  - memory-utility       — retrieval recall@k against held-out probes
 *  - dedup-catch-rate     — exact content-hash dedup catch (+ false-positive guard)
 *  - provenance-integrity — per-memory content-hash consistency + audit-chain intactness
 *  - govern-decision      — per-check precision/recall of the deterministic govern
 *                           decision over an adversarial labeled set (is the moat
 *                           merely deterministic, or actually EFFECTIVE?)
 *
 * This package MEASURES. It does not emit or sign Evidence Bundles — the
 * emit wiring (bead tr08.19) now exists at ci/emit-evidence/, which runs the
 * CI eval gates as subprocesses and shapes their verdicts into signed
 * gate-result/v1 bundles for the labs dashboard (subprocess-level v1; an
 * EvaluatorResult-level in-package emitter remains future work). Keeping
 * measurement pure (no I/O beyond the repositories/data handed in) makes each
 * evaluator independently testable and side-effect-free.
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
export type { EvaluatorResult, RetrievalProbe, DedupProbe } from './types.js';
