/**
 * groundedness eval types — the labeled fixture schema and report shapes for
 * the FAITHFULNESS/SUPPORT eval (Wave-2 C2).
 *
 * ## What this eval measures — and what it does NOT
 *
 * Given an (answer-like claim, supporting memory excerpt) pair, does the
 * memory actually SUPPORT the claim? The scorer attests
 * **support-by-admitted-facts**: whether the claim's material (terms, numbers,
 * polarity) is present in the cited memory text. It does NOT attest truth —
 * a memory can be wrong and still "support" a claim that faithfully restates
 * it. This is an eval OF the eval surface (does citation-backed answering
 * stay anchored to what the cited memory says), not an oracle.
 *
 * ## Fixture provenance — semi-synthetic-from-real, stated honestly
 *
 * The `memoryExcerpt` of every item is REAL: verbatim text sampled from
 * promoted memories in the live brain's kb-export (innocuous technical /
 * architectural memories only; anything credential- or person-shaped was
 * excluded during selection). The `claim`s are SYNTHETIC: authored for this
 * fixture — each memory yields one supported claim (a paraphrase of the
 * excerpt) and one unsupported claim (plausible but not in the excerpt: an
 * inverted number, a wrong component/mechanism, a flipped negation, a swapped
 * argument, or an overreach). `sourceMemoryId` is the export UUID for
 * provenance. Labels are by-construction ground truth (the author knows which
 * claim was derived how); scorer thresholds were then tuned on THIS fixture,
 * so reported metrics are in-sample fit, not held-out generalization — a
 * held-out set is future work and the numbers must be read with that caveat.
 */

/** Ground-truth label of a fixture item. */
export type GroundednessLabel = 'supported' | 'unsupported';

/** How an unsupported claim was derived from its memory (documentation only). */
export type Perturbation =
  | 'inverted-number' // a quantity changed to a value the memory does not carry
  | 'wrong-component' // mechanism/component replaced with a plausible other
  | 'negation-flip' // the memory's polarity inverted (allowed → forbidden, …)
  | 'argument-swap' // two roles/arguments exchanged, vocabulary unchanged
  | 'overreach'; // plausible conclusion the memory never states

/** One labeled (claim, memory-excerpt) pair. */
export interface GroundednessItem {
  /** Stable, human-readable id, e.g. `grd-confused-deputy-sup`. Unique in the set. */
  readonly id: string;
  /** kb-export UUID of the real promoted memory the excerpt came from. */
  readonly sourceMemoryId: string;
  /** Verbatim excerpt (1–3 sentences) of the real memory. */
  readonly memoryExcerpt: string;
  /** The answer-like claim to be checked against the excerpt. */
  readonly claim: string;
  /** Ground truth: does the excerpt support the claim? */
  readonly label: GroundednessLabel;
  /** For unsupported items: how the claim was perturbed. */
  readonly perturbation?: Perturbation;
  /**
   * True when scorer v1 is EMPIRICALLY CONFIRMED to get this item wrong today
   * (a documented limitation — e.g. argument swaps preserve the token set, so
   * a token-overlap scorer cannot see them). Documented misses are reported,
   * never hidden; an UNDOCUMENTED wrong prediction fails the eval closed.
   */
  readonly knownScorerMiss?: boolean;
}

/** Scorer v1's verdict on one item. */
export interface GroundednessPrediction {
  readonly predicted: GroundednessLabel;
  /** Fraction of the claim's content tokens present in the memory (after light stemming). */
  readonly tokenSupport: number;
  /** Claim numbers absent from the memory (each one is an unsupported signal). */
  readonly numberMismatches: readonly string[];
  /** Terms whose negation polarity differs between claim and memory. */
  readonly negationMismatches: readonly string[];
}

/** One scorer error (prediction != label). */
export interface GroundednessError {
  readonly itemId: string;
  readonly label: GroundednessLabel;
  readonly predicted: GroundednessLabel;
  readonly perturbation?: Perturbation;
  /** True when the item's `knownScorerMiss` already documents this error. */
  readonly documented: boolean;
}

/** The full groundedness report (attached to EvaluatorResult details as JSON). */
export interface GroundednessReport {
  readonly fixtureVersion: string;
  readonly totalItems: number;
  readonly supportedItems: number;
  readonly unsupportedItems: number;
  /** Of items predicted `supported`, the fraction actually labeled supported. */
  readonly supportedPrecision: number;
  /** Of items labeled `supported`, the fraction predicted supported. */
  readonly supportedRecall: number;
  /** Of items labeled `unsupported`, the fraction predicted unsupported. */
  readonly unsupportedCatchRate: number;
  /** Mean of supportedRecall and unsupportedCatchRate. */
  readonly balancedAccuracy: number;
  /** Per-perturbation catch counts for the unsupported segment. */
  readonly perPerturbation: ReadonlyArray<{
    readonly perturbation: Perturbation;
    readonly items: number;
    readonly caught: number;
  }>;
  readonly errors: readonly GroundednessError[];
  readonly undocumentedErrors: readonly GroundednessError[];
}
