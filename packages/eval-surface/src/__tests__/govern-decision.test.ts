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

  it('the ONLY false positives are the documented UUID over-block (heroku-key regex)', () => {
    // Real precision finding (see README §5): the `heroku-api-key` rule is a bare
    // UUID regex, so a UUID in prose (neg-uuid-in-prose-01) is over-flagged by
    // scanForSecrets / classifyContent, dragging those three checks below 1.0.
    // This is surfaced, not hidden — but it must stay bounded to exactly that one
    // benign case (FP ≤ 1 per check), so a NEW over-block regression is caught.
    const rep = report(evaluateGovernDecision());
    for (const m of rep.perCheck) {
      expect(m.falsePositives).toBeLessThanOrEqual(1);
    }
    // The three content checks lose precision only via that single case.
    const contentChecks = rep.perCheck.filter((m) => m.check !== 'boundary-disclosure');
    for (const m of contentChecks) {
      expect(m.precision).toBeGreaterThan(0.85);
    }
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
