/**
 * govern-decision evaluator unit tests.
 *
 * Asserts the eval's structural guarantees on the v1 labeled set:
 *  - It scores ≥30 cases with the four checks.
 *  - Inline secrets/PII are CAUGHT (recall > 0 on the relevant checks).
 *  - Benign negatives do NOT fire (no false positives → precision 1.0).
 *  - There are ZERO undocumented false-negatives on the shipped set (so the
 *    default CI gate is green), and the documented gaps ARE reported.
 *  - Fed a SYNTHETIC set, it correctly flags a regression (a case that should be
 *    caught but is not) as an undocumented FN → passed:false, and correctly
 *    flags a false positive on a benign case.
 */

import { describe, expect, it } from 'vitest';

import { evaluateGovernDecision, GOVERN_CASES, GOVERN_DATASET_VERSION } from '../index.js';
import type { GovernCase, GovernDecisionReport } from '../index.js';

function report(result: ReturnType<typeof evaluateGovernDecision>): GovernDecisionReport {
  return JSON.parse(String(result.details.report_json)) as GovernDecisionReport;
}

describe('evaluateGovernDecision — shipped v1 set', () => {
  it('scores at least 30 labeled cases with a version stamp', () => {
    const r = evaluateGovernDecision();
    expect(r.name).toBe('govern-decision');
    expect(Number(r.details.total_cases)).toBeGreaterThanOrEqual(30);
    expect(r.details.dataset_version).toBe(GOVERN_DATASET_VERSION);
    expect(GOVERN_CASES.length).toBe(Number(r.details.total_cases));
  });

  it('PASSES on the shipped set — zero UNDOCUMENTED false-negatives', () => {
    const r = evaluateGovernDecision();
    // The gating property: every miss is either an expected catch that fired, or
    // a documented (tracked) gap. A surprise miss would flip this false.
    expect(r.details.undocumented_false_negatives).toBe(0);
    expect(r.passed).toBe(true);
  });

  it('reports the documented gaps rather than hiding them', () => {
    const r = evaluateGovernDecision();
    // Split keys, base64 tokens, odd-field leaks etc. ARE documented FNs — the
    // honest output of the eval. There must be several.
    expect(Number(r.details.documented_false_negatives)).toBeGreaterThan(0);
  });

  it('the boundary-disclosure filter has ZERO false positives (precision 1.0)', () => {
    const rep = report(evaluateGovernDecision());
    const boundary = rep.perCheck.find((m) => m.check === 'boundary-disclosure');
    expect(boundary!.falsePositives).toBe(0);
    expect(boundary!.precision).toBe(1);
  });

  it('has ZERO false positives on EVERY check — precision 1.0 (e06.15 UUID over-block closed)', () => {
    // Before e06.15 the `heroku-api-key` rule was a bare UUID regex, so a UUID in
    // prose (`neg-uuid-in-prose-01`) over-fired scanForSecrets / classifyContent
    // / policy-pipeline (FP=1 each, precision ~0.92–0.94). The rule is now
    // context-gated, so that benign case no longer fires: precision returns to
    // 1.0 on all four checks. This is the PRECISION-UP assertion — any NEW
    // over-block regression (a benign case firing a check) flips it.
    const rep = report(evaluateGovernDecision());
    for (const m of rep.perCheck) {
      expect(m.falsePositives).toBe(0);
      expect(m.precision).toBe(1);
    }
  });

  it('holds recall on the real Heroku key in key-context (context gate did not drop detection)', () => {
    // The recall-hold counterpart to the precision fix: `sec-inline-heroku-01`
    // (a real Heroku key in `HEROKU_API_KEY=` context) must STILL be caught by
    // the in-content checks. If the context gate over-suppressed, this case would
    // become an undocumented FN and flip the eval red.
    const rep = report(evaluateGovernDecision());
    const heroFn = rep.falseNegatives.filter(
      (f) => f.caseId === 'sec-inline-heroku-01' && f.check !== 'boundary-disclosure',
    );
    expect(heroFn).toHaveLength(0);
  });

  it('catches the DOB-only PII leak on the classifier + policy pipeline (converged vocab)', () => {
    // Part 2 of e06.15: claude-runtime's PII vocab is converged UP to the
    // boundary filter's, so `pii-inline-dob-01` is no longer a documented miss on
    // policy-pipeline / content-classifier — it is caught (a TP), not an FN.
    const rep = report(evaluateGovernDecision());
    const dobFn = rep.falseNegatives.filter(
      (f) =>
        f.caseId === 'pii-inline-dob-01' &&
        (f.check === 'policy-pipeline' || f.check === 'content-classifier'),
    );
    expect(dobFn).toHaveLength(0);
  });

  it('catches inline secrets on the line-based secret scanner (recall > 0)', () => {
    const rep = report(evaluateGovernDecision());
    const secretScanner = rep.perCheck.find((m) => m.check === 'secret-scanner');
    expect(secretScanner).toBeDefined();
    expect(secretScanner!.truePositives).toBeGreaterThan(0);
    expect(secretScanner!.recall).toBeGreaterThan(0);
  });

  it('surfaces split-key and base64 evasions as documented false-negatives', () => {
    const rep = report(evaluateGovernDecision());
    const surfaces = new Set(rep.falseNegatives.map((f) => f.surface));
    expect(surfaces.has('split-multiline')).toBe(true);
    expect(surfaces.has('base64-encoded')).toBe(true);
  });

  it('demonstrates the boundary filter catching odd-field (filePath) leaks (R10)', () => {
    const rep = report(evaluateGovernDecision());
    const boundary = rep.perCheck.find((m) => m.check === 'boundary-disclosure');
    // The boundary check scans the derived free-text surface incl. metadata, so
    // the filePath/projectContext/tenant-spoof cases are TRUE POSITIVES for it —
    // proving the leak the R10 intake fix closes is a real one the filter sees.
    expect(boundary!.truePositives).toBeGreaterThan(0);
  });
});

describe('evaluateGovernDecision — synthetic regression detection', () => {
  it('flags an UNDOCUMENTED miss (a should-catch case that does not fire) as passed:false', () => {
    // A case that SHOULD be caught by the secret-scanner but carries no secret →
    // the scanner will NOT fire → an undocumented false-negative → fail closed.
    const regression: GovernCase = {
      id: 'synthetic-regression-01',
      description: 'labeled positive that the scanner cannot see (simulated regression)',
      sensitiveClass: 'secret',
      surface: 'inline',
      candidate: { content: 'this text contains no secret at all, just prose' },
      expectCaughtBy: ['secret-scanner'],
    };
    const r = evaluateGovernDecision({ cases: [regression] });
    expect(r.details.undocumented_false_negatives).toBe(1);
    expect(r.passed).toBe(false);
  });

  it('counts a firing check on a benign case as a false positive (precision < 1)', () => {
    const falsePositiveProbe: GovernCase = {
      id: 'synthetic-fp-01',
      description: 'a benign case that actually carries an inline key (mislabeled negative)',
      sensitiveClass: 'none',
      surface: 'benign',
      candidate: { content: 'oops AKIAIOSFODNN7EXAMPLE leaked into a "benign" case' },
      expectCaughtBy: [],
    };
    const rep = report(evaluateGovernDecision({ cases: [falsePositiveProbe] }));
    const secretScanner = rep.perCheck.find((m) => m.check === 'secret-scanner');
    expect(secretScanner!.falsePositives).toBe(1);
    expect(secretScanner!.precision).toBeLessThan(1);
  });

  it('a case whose miss is DOCUMENTED does not fail the eval', () => {
    const documentedGap: GovernCase = {
      id: 'synthetic-documented-01',
      description: 'a base64-wrapped key we already know the scanner misses',
      sensitiveClass: 'secret',
      surface: 'base64-encoded',
      candidate: { content: `blob ${Buffer.from('sk-xxx', 'utf8').toString('base64')}` },
      expectCaughtBy: [],
      knownFalseNegativeOf: ['secret-scanner'],
    };
    const r = evaluateGovernDecision({ cases: [documentedGap] });
    expect(r.details.undocumented_false_negatives).toBe(0);
    expect(Number(r.details.documented_false_negatives)).toBeGreaterThanOrEqual(1);
    expect(r.passed).toBe(true);
  });
});
