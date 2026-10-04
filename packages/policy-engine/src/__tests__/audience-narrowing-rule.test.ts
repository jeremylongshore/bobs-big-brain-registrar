import { describe, it, expect } from 'vitest';
import { evaluateAudienceNarrowing, recommendAudience } from '../rules/audience-narrowing-rule.js';
import { PolicyPipeline } from '../pipeline.js';
import { RECOMMENDED_POLICY_RULES, buildRecommendedPolicy } from '../recommended-policy.js';
import { makeCandidate, makeContext, FIXED_NOW, DEFAULT_TENANT } from './fixtures.js';
import { AUDIENCE_NARROWING_CASES } from './fixtures/audience-narrowing-labeled.js';

function makeRule(overrides?: Record<string, unknown>) {
  return {
    id: 'rule-audience-narrowing',
    type: 'audience_narrowing' as const,
    action: 'flag' as const,
    enabled: true,
    priority: 0,
    parameters: {},
    ...overrides,
  };
}

function candidateFor(content: string, audience?: string) {
  return makeCandidate({
    content,
    metadata:
      audience === undefined ? { filePaths: [], tags: [] } : { filePaths: [], tags: [], audience },
  });
}

const KEY = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';

describe('evaluateAudienceNarrowing', () => {
  it('passes clean content at the default audience', () => {
    const candidate = candidateFor('Use dependency injection for all services in the codebase.');
    const result = evaluateAudienceNarrowing(candidate, makeRule(), makeContext(candidate));
    expect(result.outcome).toBe('pass');
    expect(result.ruleType).toBe('audience_narrowing');
  });

  it('flags credential-shaped content declared tenant-wide and recommends owner', () => {
    const candidate = candidateFor(`The uploader uses access key ${KEY} for the bucket.`);
    const result = evaluateAudienceNarrowing(candidate, makeRule(), makeContext(candidate));
    expect(result.outcome).toBe('flag');
    expect(result.reason).toContain("narrowing to 'owner'");
    expect(result.reason).toContain('aws-key');
  });

  it('flags PII-shaped content declared tenant-wide and recommends admins', () => {
    const candidate = candidateFor('Escalate to dana.whitfield@customer-example.com for billing.');
    const result = evaluateAudienceNarrowing(candidate, makeRule(), makeContext(candidate));
    expect(result.outcome).toBe('flag');
    expect(result.reason).toContain("narrowing to 'admins'");
  });

  it('passes when the declared audience is already as narrow as recommended', () => {
    const pii = candidateFor('Escalate to dana.whitfield@customer-example.com.', 'admins');
    expect(evaluateAudienceNarrowing(pii, makeRule(), makeContext(pii)).outcome).toBe('pass');
    const secret = candidateFor(`Access key ${KEY} is on the runner.`, 'owner');
    expect(evaluateAudienceNarrowing(secret, makeRule(), makeContext(secret)).outcome).toBe('pass');
  });

  it('never returns fail, so no action can turn it into a rejection', () => {
    const candidate = candidateFor(`Access key ${KEY} is on the runner.`);
    const rule = makeRule({ action: 'reject' });
    expect(evaluateAudienceNarrowing(candidate, rule, makeContext(candidate)).outcome).toBe('flag');
    const policy = buildRecommendedPolicy(DEFAULT_TENANT, FIXED_NOW);
    const pipeline = new PolicyPipeline({ ...policy, rules: [rule] });
    expect(pipeline.evaluate(candidate).outcome).toBe('flagged');
  });

  it('never puts the matched text in the reason', () => {
    const candidate = candidateFor(`Access key ${KEY} is on the runner.`);
    const result = evaluateAudienceNarrowing(candidate, makeRule(), makeContext(candidate));
    expect(result.reason).not.toContain(KEY);
  });

  it('does not write the audience: the candidate is left exactly as declared', () => {
    const candidate = candidateFor(`Access key ${KEY} is on the runner.`);
    const before = JSON.stringify(candidate);
    evaluateAudienceNarrowing(candidate, makeRule(), makeContext(candidate));
    expect(JSON.stringify(candidate)).toBe(before);
  });

  it('flags an unrecognized declared audience instead of treating it as tenant-wide', () => {
    const candidate = candidateFor('Plain content with nothing sensitive in it at all.');
    const tampered = { ...candidate, metadata: { ...candidate.metadata, audience: 'board' } };
    const result = evaluateAudienceNarrowing(
      tampered as unknown as typeof candidate,
      makeRule(),
      makeContext(candidate),
    );
    expect(result.outcome).toBe('flag');
    expect(result.reason).toContain('not a known tier');
  });

  it('honors tier parameters and ignores an unknown tier name', () => {
    const candidate = candidateFor('Escalate to dana.whitfield@customer-example.com.');
    const owner = evaluateAudienceNarrowing(
      candidate,
      makeRule({ parameters: { piiAudience: 'owner' } }),
      makeContext(candidate),
    );
    expect(owner.reason).toContain("narrowing to 'owner'");
    const fallback = evaluateAudienceNarrowing(
      candidate,
      makeRule({ parameters: { piiAudience: 'board' } }),
      makeContext(candidate),
    );
    expect(fallback.reason).toContain("narrowing to 'admins'");
  });

  it('is in the recommended policy as an enabled flag rule', () => {
    const rule = RECOMMENDED_POLICY_RULES.find((r) => r.type === 'audience_narrowing');
    expect(rule).toMatchObject({ action: 'flag', enabled: true });
  });
});

describe('recommendAudience', () => {
  it('recommends tenant for clean content and never asks to narrow it', () => {
    expect(recommendAudience('Nothing sensitive here.', undefined)).toMatchObject({
      declared: 'tenant',
      recommended: 'tenant',
      shouldNarrow: false,
      basis: 'none',
    });
  });

  it('never recommends widening: a narrower declared tier is left alone', () => {
    for (const declared of ['admins', 'owner']) {
      expect(recommendAudience('Nothing sensitive here.', declared).shouldNarrow).toBe(false);
    }
  });

  it('prefers the credentials tier when content has both credentials and PII', () => {
    const both = `Mail dana.whitfield@customer-example.com the key ${KEY}.`;
    expect(recommendAudience(both, 'tenant')).toMatchObject({
      recommended: 'owner',
      basis: 'credentials',
      shouldNarrow: true,
    });
  });
});

/**
 * KR8.2 — the narrowing rule's OWN precision and recall, on its own hand-labeled
 * fixture. Deliberately not merged into the disclosure (secret / PII) metrics.
 */
describe('audience_narrowing — precision / recall on the hand-labeled fixture (KR8.2)', () => {
  const outcomes = AUDIENCE_NARROWING_CASES.map((c) => {
    const candidate = candidateFor(c.content, c.declared);
    const flagged =
      evaluateAudienceNarrowing(candidate, makeRule(), makeContext(candidate)).outcome === 'flag';
    return { ...c, flagged, recommended: recommendAudience(c.content, c.declared).recommended };
  });
  const tp = outcomes.filter((o) => o.shouldNarrow && o.flagged);
  const fp = outcomes.filter((o) => !o.shouldNarrow && o.flagged);
  const fn = outcomes.filter((o) => o.shouldNarrow && !o.flagged);
  const tn = outcomes.filter((o) => !o.shouldNarrow && !o.flagged);
  const precision = tp.length / (tp.length + fp.length);
  const recall = tp.length / (tp.length + fn.length);

  it('reports the measured counts', () => {
    console.info(
      `[audience_narrowing KR8.2] cases=${outcomes.length} TP=${tp.length} FP=${fp.length} ` +
        `FN=${fn.length} TN=${tn.length} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`,
    );
    expect(tp.length + fp.length + fn.length + tn.length).toBe(AUDIENCE_NARROWING_CASES.length);
  });

  it('holds the measured floors (precision >= 0.80, recall >= 0.85)', () => {
    expect(precision).toBeGreaterThanOrEqual(0.8);
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });

  it('gets every case that is not a documented gap right', () => {
    const wrong = outcomes.filter((o) => o.knownGap === undefined && o.flagged !== o.shouldNarrow);
    expect(wrong.map((o) => o.id)).toEqual([]);
  });

  it('every miss and every false alarm is a documented gap', () => {
    for (const o of [...fp, ...fn]) expect(o.knownGap, o.id).toBeDefined();
  });

  it('recommends the hand-labeled tier on every true positive', () => {
    for (const o of tp) expect(o.recommended, o.id).toBe(o.expected);
  });

  it('has unique case ids and both classes represented', () => {
    const ids = AUDIENCE_NARROWING_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(AUDIENCE_NARROWING_CASES.filter((c) => c.shouldNarrow).length).toBeGreaterThanOrEqual(
      10,
    );
    expect(AUDIENCE_NARROWING_CASES.filter((c) => !c.shouldNarrow).length).toBeGreaterThanOrEqual(
      10,
    );
  });
});
