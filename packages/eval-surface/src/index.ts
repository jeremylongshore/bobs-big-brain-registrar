/**
 * @qmd-team-intent-kb/eval-surface — QMD's functional eval surface.
 *
 * Three pure evaluators that measure whether the curated memory store is doing
 * its job, each returning an Evidence-Bundle-friendly EvaluatorResult:
 *  - memory-utility       — retrieval recall@k against held-out probes
 *  - dedup-catch-rate     — exact content-hash dedup catch (+ false-positive guard)
 *  - provenance-integrity — per-memory content-hash consistency + audit-chain intactness
 *
 * This package MEASURES. It does not emit or sign Evidence Bundles — wiring the
 * results into a signed bundle at promotion time is bead tr08.19. Keeping
 * measurement pure (no I/O beyond the repositories handed in) makes each
 * evaluator independently testable and side-effect-free.
 */

export { evaluateMemoryUtility, type MemoryUtilityOptions } from './memory-utility.js';
export { evaluateDedupCatchRate, type DedupCatchRateOptions } from './dedup-catchrate.js';
export {
  evaluateProvenanceIntegrity,
  type ProvenanceIntegrityOptions,
} from './provenance-integrity.js';
export type { EvaluatorResult, RetrievalProbe, DedupProbe } from './types.js';
