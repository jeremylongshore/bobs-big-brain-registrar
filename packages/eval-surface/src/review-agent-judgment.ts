import { z } from 'zod';

export const REVIEW_LABELS = Object.freeze(['promote', 'hold', 'reject'] as const);
export type ReviewLabel = (typeof REVIEW_LABELS)[number];
const Label = z.enum(REVIEW_LABELS);
const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
const Case = z.object({ id: Id, expected: Label, stratum: Id }).strict();
const Prediction = z.object({ caseId: Id, label: Label }).strict();
const Floor = z.number().finite().gt(0).lte(1);
const Floors = z.object({ promote: Floor, hold: Floor, reject: Floor }).strict();

export type ReviewJudgmentCase = z.infer<typeof Case>;
export type ReviewJudgmentPrediction = z.infer<typeof Prediction>;
export type ReviewRecallFloors = z.infer<typeof Floors>;
type Confusion = Record<ReviewLabel, Record<ReviewLabel | 'missing', number>>;

export interface ReviewClassMetrics {
  support: number;
  predicted: number;
  hits: number;
  misses: number;
  falsePositives: number;
  recall: number | null;
  precision: number | null;
}

function measure(
  cases: readonly ReviewJudgmentCase[],
  predictions: ReadonlyMap<string, ReviewLabel>,
) {
  const confusion: Confusion = {
    promote: { promote: 0, hold: 0, reject: 0, missing: 0 },
    hold: { promote: 0, hold: 0, reject: 0, missing: 0 },
    reject: { promote: 0, hold: 0, reject: 0, missing: 0 },
  };
  const rows = cases.map((item) => {
    const predicted = predictions.get(item.id) ?? 'missing';
    confusion[item.expected][predicted]++;
    return {
      caseId: item.id,
      expected: item.expected,
      predicted,
      correct: predicted === item.expected,
    };
  });
  const perClass = Object.fromEntries(
    REVIEW_LABELS.map((label) => {
      const support = Object.values(confusion[label]).reduce((a, b) => a + b, 0);
      const predicted = REVIEW_LABELS.reduce((total, truth) => total + confusion[truth][label], 0);
      const hits = confusion[label][label];
      const metrics: ReviewClassMetrics = {
        support,
        predicted,
        hits,
        misses: support - hits,
        falsePositives: predicted - hits,
        recall: support === 0 ? null : hits / support,
        precision: predicted === 0 ? null : hits / predicted,
      };
      return [label, metrics];
    }),
  ) as Record<ReviewLabel, ReviewClassMetrics>;
  return { total: cases.length, confusion, perClass, rows };
}

/**
 * Scores supplied labels, never their human provenance or frozen-file integrity.
 * The caller must establish those independently before interpreting this report.
 * Floors are caller-supplied, predeclared policy, not fitted to predictions here.
 */
export function scoreReviewJudgments(
  casesInput: unknown,
  predictionsInput: unknown,
  floorsInput: unknown,
) {
  const parsedCases = z.array(Case).min(1).safeParse(casesInput);
  const parsedPredictions = z.array(Prediction).safeParse(predictionsInput);
  const parsedFloors = Floors.safeParse(floorsInput);
  if (!parsedCases.success || !parsedPredictions.success || !parsedFloors.success)
    throw new Error('Invalid review judgment evaluation input');
  const cases = parsedCases.data;
  const predictions = parsedPredictions.data;
  const floors = parsedFloors.data;
  const caseIds = new Set(cases.map((item) => item.id));
  const predictionIds = new Set(predictions.map((item) => item.caseId));
  if (
    caseIds.size !== cases.length ||
    predictionIds.size !== predictions.length ||
    predictions.some((item) => !caseIds.has(item.caseId))
  )
    throw new Error('Invalid review judgment evaluation identities');

  const byId = new Map(predictions.map((item) => [item.caseId, item.label]));
  const overall = measure(cases, byId);
  const strata = [...new Set(cases.map((item) => item.stratum))].sort().map((stratum) => ({
    stratum,
    ...measure(
      cases.filter((item) => item.stratum === stratum),
      byId,
    ),
  }));
  const failures: {
    scope: string;
    label: ReviewLabel;
    reason: 'missing-support' | 'below-floor';
  }[] = [];
  const check = (scope: string, label: ReviewLabel, metrics: ReviewClassMetrics) => {
    // No rounding before the gate; an unrepresented class is unmeasured, never perfect.
    if (metrics.recall === null) failures.push({ scope, label, reason: 'missing-support' });
    else if (metrics.recall < floors[label]) failures.push({ scope, label, reason: 'below-floor' });
  };
  for (const label of REVIEW_LABELS) check('overall', label, overall.perClass[label]);
  const paraphrase = measure(
    cases.filter((item) => item.stratum === 'paraphrase-duplicate'),
    byId,
  );
  // Otherwise many easy rejections could hide over-promotion of paraphrase duplicates.
  check('paraphrase-duplicate', 'reject', paraphrase.perClass.reject);
  return { passed: failures.length === 0, floors, ...overall, strata, failures };
}
