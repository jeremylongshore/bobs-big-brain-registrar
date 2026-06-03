/**
 * eval-surface types — the structured results the three evaluators produce.
 *
 * These shapes are deliberately Evidence-Bundle-friendly: each evaluator yields
 * an `EvaluatorResult` with a stable `name`, a binary `passed`, a numeric
 * `score` in [0,1], a `threshold`, and a `details` map. The wiring bead
 * (tr08.19) rolls a set of these into a canonical Evidence Bundle via
 * @intentsolutions/core, naming each subject `qmd:<name>` and hashing the
 * verdict. This package stays pure: it measures, it does not emit or sign.
 */

/** A single evaluator's verdict. */
export interface EvaluatorResult {
  /** Stable evaluator id, e.g. `memory-utility`. Used in the bundle subject name. */
  readonly name: string;
  /** Binary outcome — the platform refuses gradient "scores" as the verdict. */
  readonly passed: boolean;
  /** Continuous quality measure in [0,1] for reporting (NOT the pass/fail decision). */
  readonly score: number;
  /** Pass threshold the score was compared against. */
  readonly threshold: number;
  /** Structured, JSON-serializable detail for the report + bundle payload. */
  readonly details: Record<string, number | string | boolean>;
}

/** One query→expected-memory probe for the memory-utility evaluator. */
export interface RetrievalProbe {
  /** Natural-language query fed to the store's text search. */
  readonly query: string;
  /** Tenant scope for the search (isolation is per-tenant by design). */
  readonly tenantId: string;
  /** Ids of memories that SHOULD appear in the top-k results. */
  readonly expectedMemoryIds: readonly string[];
  /** Top-k cutoff. Defaults applied by the evaluator when omitted. */
  readonly k?: number;
}

/** One near-duplicate probe for the dedup-catch-rate evaluator. */
export interface DedupProbe {
  /** Content known to be a near-duplicate of an already-stored memory. */
  readonly nearDuplicateContent: string;
  /** Tenant scope. */
  readonly tenantId: string;
  /** Id of the original memory this should be recognized as a duplicate of. */
  readonly originalMemoryId: string;
}
