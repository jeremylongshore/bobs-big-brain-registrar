/**
 * Human-escalation hold (Epic K bead K6) — escalation rate over the
 * govern-decision adversarial set (dataset/v1), the hand-labeled fixture behind
 * the govern gate that 014-AT-DECR's review path re-runs.
 *
 * Reported on its own. It is NOT blended into the per-check precision / recall
 * of `evaluateGovernDecision`: this counts how often a person is asked, not how
 * often a check is right.
 */

import { describe, expect, it } from 'vitest';

import { buildRecommendedPolicy, measureHoldEscalation } from '@qmd-team-intent-kb/policy-engine';

import { CASE_DEFAULTS, GOVERN_CASES } from '../govern-decision/dataset/v1/index.js';
import { loadDataset } from '../govern-decision/dataset/v1/load.js';

describe('hold escalation rate on the govern-decision adversarial set', () => {
  const loaded = loadDataset();
  const policy = buildRecommendedPolicy(CASE_DEFAULTS.tenantId, '2026-06-30T00:00:00.000Z');
  const report = measureHoldEscalation(
    loaded.map((c) => c.candidate),
    policy,
  );
  const held = loaded.filter((c) => report.heldIds.includes(c.candidate.id));

  it('reports the measured counts', () => {
    console.info(
      `[hold escalation / govern-decision v1] cases=${report.total} held=${report.held} ` +
        `rate=${report.escalationRate.toFixed(3)} rejected=${report.rejected} ` +
        `flagged_other=${report.flaggedOther} approved=${report.approved} ` +
        `by_trigger=${JSON.stringify(report.byTrigger)} held_ids=${held.map((c) => c.def.id).join(',')}`,
    );
    expect(report.total).toBe(GOVERN_CASES.length);
    expect(report.held + report.rejected + report.flaggedOther + report.approved).toBe(
      report.total,
    );
  });

  it('pins the escalation rate: 3 of 33 cases are held', () => {
    expect(report).toMatchObject({
      total: 33,
      held: 3,
      rejected: 14,
      flaggedOther: 4,
      approved: 12,
    });
    expect(held.map((c) => c.def.id).sort()).toEqual([
      'pii-inline-dob-01',
      'pii-inline-email-01',
      'pii-inline-ssn-01',
    ]);
  });

  it('never holds a benign negative', () => {
    expect(held.filter((c) => c.def.sensitiveClass === 'none').map((c) => c.def.id)).toEqual([]);
  });
});
