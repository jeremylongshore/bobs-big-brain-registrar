/**
 * groundedness evaluator — does an answer-like claim stay ANCHORED to the
 * memory it cites? (Wave-2 C2 · GSB blueprint groundedness layer)
 *
 * ## Why
 *
 * The retrieval evals measure whether the right memory comes BACK; nothing
 * measured whether what gets SAID on top of a retrieved memory is actually
 * supported by it. This evaluator scores the deterministic groundedness
 * scorer (scorer v1) against a labeled fixture of (claim, real-memory-excerpt)
 * pairs and reports SEGMENTED metrics — supported-precision and
 * unsupported-catch-rate — so over-flagging and under-catching are visible
 * separately, never averaged into one number.
 *
 * ## Honesty box (read before trusting the numbers)
 *
 *   - Scorer v1 attests SUPPORT-BY-ADMITTED-FACTS (terms/numbers/polarity
 *     present in the cited text), not truth and not entailment. It is an eval
 *     of the eval surface, not an oracle.
 *   - The fixture is SEMI-SYNTHETIC-FROM-REAL: real promoted-memory excerpts,
 *     synthetically authored claims (see fixture/v1). Scorer thresholds were
 *     tuned on this same fixture — metrics are in-sample fit.
 *   - Known limitations (argument swaps etc.) are carried as documented
 *     scorer misses in the fixture and REPORTED; an undocumented wrong
 *     prediction fails the eval closed (same contract as govern-decision).
 *   - The optional LLM judge (./groundedness/llm-judge.ts) is an OFFLINE
 *     COMPARISON ARM only: env-gated, never invoked here, never in CI, never
 *     a gate. No LLM runs in any gating path.
 *
 * Pure w.r.t. durable state: no I/O, no model calls, in-memory scoring only.
 */

import type { EvaluatorResult } from './types.js';
import type {
  GroundednessError,
  GroundednessItem,
  GroundednessReport,
  Perturbation,
} from './groundedness/types.js';
import { FIXTURE_VERSION, GROUNDEDNESS_ITEMS } from './groundedness/fixture/v1/index.js';
import { scoreGroundedness } from './groundedness/scorer.js';

/**
 * Committed metric floors — DERIVED FROM THE FIRST REAL RUN of scorer v1 over
 * fixture v1 (measure, then commit; never invented). The run is deterministic
 * (fixed fixture, pure scorer), so equality holds until either changes; the
 * floors exist so a scorer or fixture change that degrades a segment fails
 * loudly instead of silently shifting the balance.
 */
export const GROUNDEDNESS_FLOORS = {
  // Measured 2026-07-19 on fixture v1.0.0 with scorer v1: supported-precision
  // 0.8824 (30 true supported / 34 predicted supported — the 4 documented
  // scorer misses predict "supported" on unsupported items), unsupported
  // catch-rate 0.8667 (26/30; misses = 3 argument swaps + 1 distant negation,
  // all fixture-documented). Floors sit a hair under the measured values so
  // an equal re-run passes; ONE additional error in either segment lands
  // below the floor and fails the gate.
  supportedPrecision: 0.88,
  unsupportedCatchRate: 0.86,
} as const;

const PERTURBATIONS: readonly Perturbation[] = [
  'inverted-number',
  'wrong-component',
  'negation-flip',
  'argument-swap',
  'overreach',
];

export interface GroundednessOptions {
  /** Override the labeled fixture (defaults to fixture/v1). Used by tests. */
  readonly items?: readonly GroundednessItem[];
}

/**
 * Run the groundedness eval.
 *
 * Verdict (`passed`) is fail-closed on BOTH properties:
 *   1. zero UNDOCUMENTED scorer errors (every wrong prediction is either a
 *      fixture-documented limitation or a regression that flips the gate);
 *   2. the segmented metrics hold their committed floors.
 *
 * The continuous `score` is balanced accuracy — a reporting number, never the
 * pass/fail decision (the platform refuses gradient scores AS the verdict).
 */
export function evaluateGroundedness(options: GroundednessOptions = {}): EvaluatorResult {
  const items = options.items ?? GROUNDEDNESS_ITEMS;

  let predictedSupported = 0;
  let supportedCorrect = 0; // predicted supported AND labeled supported
  let supportedTotal = 0;
  let supportedCaught = 0; // labeled supported, predicted supported
  let unsupportedTotal = 0;
  let unsupportedCaught = 0; // labeled unsupported, predicted unsupported

  const errors: GroundednessError[] = [];
  const perPerturbation = new Map<Perturbation, { items: number; caught: number }>(
    PERTURBATIONS.map((p) => [p, { items: 0, caught: 0 }]),
  );

  for (const item of items) {
    const prediction = scoreGroundedness(item.claim, item.memoryExcerpt);
    const predicted = prediction.predicted;

    if (predicted === 'supported') {
      predictedSupported += 1;
      if (item.label === 'supported') supportedCorrect += 1;
    }
    if (item.label === 'supported') {
      supportedTotal += 1;
      if (predicted === 'supported') supportedCaught += 1;
    } else {
      unsupportedTotal += 1;
      if (predicted === 'unsupported') unsupportedCaught += 1;
      if (item.perturbation !== undefined) {
        const bucket = perPerturbation.get(item.perturbation)!;
        bucket.items += 1;
        if (predicted === 'unsupported') bucket.caught += 1;
      }
    }

    if (predicted !== item.label) {
      errors.push({
        itemId: item.id,
        label: item.label,
        predicted,
        ...(item.perturbation !== undefined ? { perturbation: item.perturbation } : {}),
        documented: item.knownScorerMiss === true,
      });
    }
  }

  const supportedPrecision =
    predictedSupported === 0 ? 1 : Number((supportedCorrect / predictedSupported).toFixed(4));
  const supportedRecall =
    supportedTotal === 0 ? 1 : Number((supportedCaught / supportedTotal).toFixed(4));
  const unsupportedCatchRate =
    unsupportedTotal === 0 ? 1 : Number((unsupportedCaught / unsupportedTotal).toFixed(4));
  const balancedAccuracy = Number(((supportedRecall + unsupportedCatchRate) / 2).toFixed(4));

  const undocumentedErrors = errors.filter((e) => !e.documented);

  const report: GroundednessReport = {
    fixtureVersion: FIXTURE_VERSION,
    totalItems: items.length,
    supportedItems: supportedTotal,
    unsupportedItems: unsupportedTotal,
    supportedPrecision,
    supportedRecall,
    unsupportedCatchRate,
    balancedAccuracy,
    perPerturbation: PERTURBATIONS.map((p) => ({
      perturbation: p,
      ...perPerturbation.get(p)!,
    })),
    errors,
    undocumentedErrors,
  };

  const passed =
    undocumentedErrors.length === 0 &&
    supportedPrecision >= GROUNDEDNESS_FLOORS.supportedPrecision &&
    unsupportedCatchRate >= GROUNDEDNESS_FLOORS.unsupportedCatchRate;

  return {
    name: 'groundedness',
    passed,
    score: balancedAccuracy,
    threshold: GROUNDEDNESS_FLOORS.unsupportedCatchRate,
    details: {
      fixture_version: FIXTURE_VERSION,
      total_items: report.totalItems,
      supported_items: report.supportedItems,
      unsupported_items: report.unsupportedItems,
      supported_precision: supportedPrecision,
      supported_recall: supportedRecall,
      unsupported_catch_rate: unsupportedCatchRate,
      balanced_accuracy: balancedAccuracy,
      undocumented_errors: undocumentedErrors.length,
      documented_errors: errors.length - undocumentedErrors.length,
      floor_supported_precision: GROUNDEDNESS_FLOORS.supportedPrecision,
      floor_unsupported_catch_rate: GROUNDEDNESS_FLOORS.unsupportedCatchRate,
      report_json: JSON.stringify(report),
    },
  };
}
