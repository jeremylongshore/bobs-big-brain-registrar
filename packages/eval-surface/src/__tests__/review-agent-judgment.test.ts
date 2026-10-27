import { describe, expect, it } from 'vitest';
import {
  REVIEW_LABELS,
  scoreReviewJudgments,
  type ReviewJudgmentCase,
  type ReviewJudgmentPrediction,
} from '../review-agent-judgment.js';

const floors = { promote: 1, hold: 1, reject: 1 };
const cases: ReviewJudgmentCase[] = [
  { id: 'novel', expected: 'promote', stratum: 'ordinary' },
  { id: 'ambiguous', expected: 'hold', stratum: 'ordinary' },
  { id: 'unsafe', expected: 'reject', stratum: 'ordinary' },
  { id: 'near-duplicate', expected: 'reject', stratum: 'paraphrase-duplicate' },
];
const perfect: ReviewJudgmentPrediction[] = cases.map((item) => ({
  caseId: item.id,
  label: item.expected,
}));

describe('three-class review-agent judgment measurement', () => {
  it('reports all class denominators, exact scores, confusion and per-case outcomes', () => {
    const report = scoreReviewJudgments(cases, perfect, floors);
    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.perClass.reject).toEqual({
      support: 2,
      predicted: 2,
      hits: 2,
      misses: 0,
      falsePositives: 0,
      precision: 1,
      recall: 1,
    });
    expect(report.confusion).toEqual({
      promote: { promote: 1, hold: 0, reject: 0, missing: 0 },
      hold: { promote: 0, hold: 1, reject: 0, missing: 0 },
      reject: { promote: 0, hold: 0, reject: 2, missing: 0 },
    });
    expect(report.rows.every((row) => row.correct)).toBe(true);
  });

  it.each(REVIEW_LABELS)('a constant %s classifier cannot pass all three floors', (label) => {
    const report = scoreReviewJudgments(
      cases,
      cases.map((item) => ({ caseId: item.id, label })),
      floors,
    );
    expect(report.passed).toBe(false);
    for (const expected of REVIEW_LABELS.filter((value) => value !== label))
      expect(report.perClass[expected].recall).toBe(0);
  });

  it.each(['promote', 'reject'] as const)(
    'HOLD instead of %s counts as a miss for the true class',
    (expected) => {
      const changed = cases.find((item) => item.expected === expected)!;
      const report = scoreReviewJudgments(
        cases,
        perfect.map((item) => (item.caseId === changed.id ? { ...item, label: 'hold' } : item)),
        floors,
      );
      expect(report.passed).toBe(false);
      expect(report.confusion[expected].hold).toBe(1);
      expect(report.perClass[expected].misses).toBe(1);
      expect(report.perClass.hold.falsePositives).toBe(1);
      expect(report.perClass.hold.precision).toBe(0.5);
    },
  );

  it.each(REVIEW_LABELS)(
    'an omitted %s prediction is a missing outcome, not a correct hold',
    (expected) => {
      const changed = cases.find((item) => item.expected === expected)!;
      const report = scoreReviewJudgments(
        cases,
        perfect.filter((item) => item.caseId !== changed.id),
        floors,
      );
      expect(report.passed).toBe(false);
      expect(report.confusion[expected].missing).toBe(1);
      expect(report.perClass[expected].misses).toBe(1);
      expect(report.rows.find((row) => row.caseId === changed.id)).toMatchObject({
        predicted: 'missing',
        correct: false,
      });
    },
  );

  it('empty predictions miss every class and have undefined precision, never a clean evaluation', () => {
    const report = scoreReviewJudgments(cases, [], floors);
    expect(report.passed).toBe(false);
    for (const label of REVIEW_LABELS)
      expect(report.perClass[label]).toMatchObject({ hits: 0, recall: 0, precision: null });
  });

  it.each(REVIEW_LABELS)('a dataset without %s support is unmeasured and fails', (missing) => {
    const remaining = cases.filter((item) => item.expected !== missing);
    const ids = new Set(remaining.map((item) => item.id));
    const report = scoreReviewJudgments(
      remaining,
      perfect.filter((item) => ids.has(item.caseId)),
      floors,
    );
    expect(report.passed).toBe(false);
    expect(report.perClass[missing].recall).toBeNull();
    expect(report.failures).toContainEqual({
      scope: 'overall',
      label: missing,
      reason: 'missing-support',
    });
  });

  it('requires the paraphrase-duplicate reject stratum, including when all other predictions are perfect', () => {
    const remaining = cases.slice(0, 3);
    const report = scoreReviewJudgments(remaining, perfect.slice(0, 3), floors);
    expect(report.failures).toEqual([
      { scope: 'paraphrase-duplicate', label: 'reject', reason: 'missing-support' },
    ]);
    const relabeled = cases.map((item) =>
      item.stratum === 'paraphrase-duplicate' ? { ...item, expected: 'hold' as const } : item,
    );
    expect(
      scoreReviewJudgments(
        relabeled,
        relabeled.map((item) => ({ caseId: item.id, label: item.expected })),
        floors,
      ).passed,
    ).toBe(false);
  });

  it('easy rejection cases cannot mask over-promotion of paraphrase duplicates', () => {
    const expanded = [
      ...cases,
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `easy-${i}`,
        expected: 'reject' as const,
        stratum: 'ordinary',
      })),
    ];
    const predictions = expanded.map((item) => ({
      caseId: item.id,
      label: item.id === 'near-duplicate' ? ('promote' as const) : item.expected,
    }));
    const report = scoreReviewJudgments(expanded, predictions, { ...floors, reject: 0.9 });
    expect(report.perClass.reject.recall).toBeGreaterThan(0.9);
    expect(report.failures).toEqual([
      { scope: 'paraphrase-duplicate', label: 'reject', reason: 'below-floor' },
    ]);
    expect(
      report.strata.find((item) => item.stratum === 'paraphrase-duplicate')!.confusion.reject
        .promote,
    ).toBe(1);
  });

  it('compares exact unrounded ratios at the floor boundary', () => {
    const expanded = [
      ...cases,
      { id: 'second', expected: 'promote' as const, stratum: 'ordinary' },
      { id: 'third', expected: 'promote' as const, stratum: 'ordinary' },
    ];
    const predictions = expanded
      .filter((item) => item.id !== 'third')
      .map((item) => ({ caseId: item.id, label: item.expected }));
    expect(scoreReviewJudgments(expanded, predictions, { ...floors, promote: 2 / 3 }).passed).toBe(
      true,
    );
    expect(scoreReviewJudgments(expanded, predictions, { ...floors, promote: 0.6667 }).passed).toBe(
      false,
    );
  });

  it.each([
    undefined,
    {},
    { ...floors, promote: 0 },
    { ...floors, hold: -1 },
    { ...floors, reject: 1.1 },
    { ...floors, reject: NaN },
    { ...floors, reject: Infinity },
    { ...floors, reject: '1' },
    { ...floors, extra: 1 },
  ])('refuses missing, vacuous or malformed predeclared floors: %j', (bad) => {
    expect(() => scoreReviewJudgments(cases, perfect, bad)).toThrow(
      'Invalid review judgment evaluation input',
    );
  });

  it.each([
    [[], []],
    [[...cases, cases[0]], perfect],
    [cases, [...perfect, perfect[0]]],
    [cases, [...perfect, { caseId: 'unknown-private-sentinel', label: 'reject' }]],
    [[...cases, { id: 'invalid', expected: 'private-sentinel', stratum: 'ordinary' }], perfect],
    [cases, [{ caseId: 'novel', label: 'private-sentinel' }]],
    [cases, [{ caseId: 'novel', label: 'promote', reason: 'private-sentinel' }]],
    [[{ ...cases[0], id: '../private-sentinel' }], []],
  ])(
    'refuses malformed, duplicate or unknown identities without reproducing private input',
    (badCases, badPredictions) => {
      let message = '';
      try {
        scoreReviewJudgments(badCases, badPredictions, floors);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^Invalid review judgment evaluation (input|identities)$/);
      expect(message).not.toContain('private-sentinel');
    },
  );

  it('does not mutate caller inputs or retain mutable floor references', () => {
    const input = structuredClone({ cases, perfect, floors });
    const before = structuredClone(input);
    const report = scoreReviewJudgments(input.cases, input.perfect, input.floors);
    expect(input).toEqual(before);
    input.floors.reject = 0.1;
    expect(report.floors.reject).toBe(1);
  });
});
