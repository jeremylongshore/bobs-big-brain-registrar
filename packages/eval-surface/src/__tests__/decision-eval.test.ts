/**
 * Decision-case eval unit tests (Wave-2 C3).
 *
 * Asserts the structural guarantees of the state-dependent govern-decision
 * section on the shipped decision set:
 *  - Real-machinery wiring: catches ride the production dedup_check /
 *    contradiction_check rules and the real detectSupersession, over a real
 *    in-memory store.
 *  - The shipped set has ZERO undocumented false-negatives (CI gate green)
 *    while the documented gaps (re-cased dup, low-overlap + cross-category
 *    contradiction, reworded-title supersession) ARE reported.
 *  - Precision is 1.0 on every decision check (no firings on clean cases).
 *  - The report breaks out the duplicate / contradiction / supersession
 *    classes separately (the C3 requirement).
 *  - Fed a synthetic regression (an expected catch that cannot fire) the eval
 *    reports an UNDOCUMENTED false-negative and evaluateGovernDecision flips
 *    passed:false; fed a firing clean case it counts a false positive.
 */

import { describe, expect, it } from 'vitest';

import {
  DECISION_CASES,
  DECISION_DATASET_VERSION,
  evaluateDecisionCases,
  evaluateGovernDecision,
} from '../index.js';
import type { DecisionCase } from '../index.js';

describe('evaluateDecisionCases — shipped decision set', () => {
  const report = evaluateDecisionCases();

  it('scores the shipped set with a version stamp and all three classes', () => {
    expect(report.datasetVersion).toBe(DECISION_DATASET_VERSION);
    expect(report.totalCases).toBe(DECISION_CASES.length);
    expect(report.totalCases).toBeGreaterThanOrEqual(14);
    const classes = report.perClass.map((c) => c.decisionClass);
    expect(classes).toEqual(['duplicate', 'contradiction', 'supersession']);
  });

  it('has ZERO undocumented false-negatives (the CI gate is green)', () => {
    expect(report.undocumentedFalseNegatives).toHaveLength(0);
  });

  it('reports the documented gaps instead of hiding them', () => {
    const documented = report.falseNegatives.filter((f) => f.documented);
    expect(documented.length).toBeGreaterThanOrEqual(4);
    const byId = new Set(documented.map((f) => `${f.caseId}:${f.check}`));
    // The four gaps this set proves out — each a real, tracked blind spot.
    expect(byId.has('dup-recased-01:dedup-rule')).toBe(true);
    expect(byId.has('contra-low-overlap-01:contradiction-rule')).toBe(true);
    expect(byId.has('contra-cross-category-01:contradiction-rule')).toBe(true);
    expect(byId.has('sup-reworded-title-01:supersession-detector')).toBe(true);
  });

  it('has precision 1.0 on every decision check (clean cases never fire)', () => {
    for (const m of report.perCheck) {
      expect(m.falsePositives).toBe(0);
      expect(m.precision).toBe(1);
    }
  });

  it('catches the exact duplicate through the real dedup rule', () => {
    const dupMisses = report.falseNegatives.filter(
      (f) => f.caseId === 'dup-exact-01' || f.caseId === 'dup-exact-02',
    );
    expect(dupMisses).toHaveLength(0);
  });

  it('per-class breakout carries scored pairs and a catch rate in [0,1]', () => {
    for (const c of report.perClass) {
      expect(c.scoredPairs).toBeGreaterThan(0);
      expect(c.catchRate).toBeGreaterThanOrEqual(0);
      expect(c.catchRate).toBeLessThanOrEqual(1);
      expect(c.caught + c.documentedMisses).toBeLessThanOrEqual(c.scoredPairs);
    }
  });
});

describe('evaluateDecisionCases — synthetic regressions', () => {
  const cleanBase: DecisionCase = {
    id: 'syn-clean-01',
    description: 'synthetic clean case',
    decisionClass: 'clean',
    candidate: {
      title: 'Totally unrelated topic',
      content: 'The build cache is keyed on the lockfile hash.',
      category: 'reference',
    },
    existingActives: [
      {
        title: 'Another topic entirely',
        content: 'Weekly reports render as static HTML from the reporting app.',
        category: 'reference',
      },
    ],
    expectFiredBy: [],
  };

  it('flags an UNDOCUMENTED false-negative when an expected catch cannot fire', () => {
    const regression: DecisionCase = {
      id: 'syn-regression-01',
      description: 'expects dedup to fire on non-duplicate content (cannot happen)',
      decisionClass: 'duplicate',
      candidate: {
        title: 'Not a duplicate',
        content: 'This content shares nothing with the existing memory.',
        category: 'reference',
      },
      existingActives: [
        {
          title: 'Existing memory',
          content: 'A completely different sentence about the audit log.',
          category: 'reference',
        },
      ],
      expectFiredBy: ['dedup-rule'],
    };
    const rep = evaluateDecisionCases([regression, cleanBase]);
    expect(rep.undocumentedFalseNegatives).toHaveLength(1);
    expect(rep.undocumentedFalseNegatives[0]).toMatchObject({
      caseId: 'syn-regression-01',
      check: 'dedup-rule',
      documented: false,
    });

    // ...and the surprise flips the WHOLE govern-decision eval red.
    const result = evaluateGovernDecision({ decisionCases: [regression, cleanBase] });
    expect(result.passed).toBe(false);
  });

  it('counts a false positive when a clean case fires a check', () => {
    const firingClean: DecisionCase = {
      ...cleanBase,
      id: 'syn-clean-fires-01',
      description: 'labeled clean but content duplicates the existing active',
      candidate: {
        title: 'Same content as existing',
        content: 'Weekly reports render as static HTML from the reporting app.',
        category: 'reference',
      },
    };
    const rep = evaluateDecisionCases([firingClean]);
    const dedup = rep.perCheck.find((m) => m.check === 'dedup-rule');
    expect(dedup!.falsePositives).toBe(1);
    expect(dedup!.precision).toBeLessThan(1);
  });
});

describe('evaluateGovernDecision — integrated decision section', () => {
  it('exposes the decision breakout in details and report_json', () => {
    const r = evaluateGovernDecision();
    expect(r.details.decision_dataset_version).toBe(DECISION_DATASET_VERSION);
    expect(Number(r.details.decision_total_cases)).toBe(DECISION_CASES.length);
    expect(r.details.decision_undocumented_false_negatives).toBe(0);
    expect(r.details['decision.catchrate.duplicate']).toBeGreaterThan(0);
    expect(r.details['decision.catchrate.contradiction']).toBeGreaterThan(0);
    expect(r.details['decision.catchrate.supersession']).toBeGreaterThan(0);
    const report = JSON.parse(String(r.details.report_json)) as {
      decisionCases: { perClass: unknown[] };
    };
    expect(report.decisionCases.perClass).toHaveLength(3);
  });
});
