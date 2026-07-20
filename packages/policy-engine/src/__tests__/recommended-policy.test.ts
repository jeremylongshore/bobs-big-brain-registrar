/**
 * Recommended-policy + completeness-gate tests (bead qmd-team-intent-kb-5bm.2).
 *
 * The load-bearing test is `covers every registered rule type` — it is the
 * anti-dormancy gate. If someone adds a rule to RULE_REGISTRY without adding it
 * to RECOMMENDED_POLICY_RULES, this fails in CI, forcing a deliberate
 * enable/waive decision instead of a silently-inert rule (the exact failure mode
 * the ontology audit found in the live policy: 6 of 8 rules dormant).
 */
import { describe, it, expect } from 'vitest';
import {
  RULE_REGISTRY,
  RECOMMENDED_POLICY_RULES,
  buildRecommendedPolicy,
  findUncoveredRuleTypes,
  assertPolicyCompleteness,
} from '../index.js';
import { GovernancePolicy, type PolicyRuleType } from '@qmd-team-intent-kb/schema';

const NOW = '2026-07-17T00:00:00.000Z';

describe('RECOMMENDED_POLICY_RULES', () => {
  it('covers every registered rule type (anti-dormancy gate)', () => {
    const recommended = new Set(RECOMMENDED_POLICY_RULES.map((r) => r.type));
    const registered = Object.keys(RULE_REGISTRY) as PolicyRuleType[];
    const missing = registered.filter((t) => !recommended.has(t));
    expect(
      missing,
      `registered rules missing from RECOMMENDED_POLICY_RULES: ${missing.join(', ')}`,
    ).toEqual([]);
    // And no phantom types that are not registered.
    const registeredSet = new Set(registered);
    for (const r of RECOMMENDED_POLICY_RULES) expect(registeredSet.has(r.type)).toBe(true);
  });

  it('keeps the hard boundaries as reject and the rest as flag', () => {
    const byType = new Map(RECOMMENDED_POLICY_RULES.map((r) => [r.type, r.action]));
    expect(byType.get('secret_detection')).toBe('reject');
    expect(byType.get('content_length')).toBe('reject');
    expect(byType.get('tenant_match')).toBe('reject');
    // 5kw.3: relevance_score carries action 'reject' but its evaluator is
    // SOURCE-KEYED — only the sources in rejectSources can return a rejectable
    // 'fail'; every other source flags at most. The reject surface must stay
    // scoped to import-class sources.
    expect(byType.get('relevance_score')).toBe('reject');
    const relevance = RECOMMENDED_POLICY_RULES.find((r) => r.type === 'relevance_score');
    expect(relevance?.parameters['rejectSources']).toEqual(['import', 'bulk_import']);
    for (const t of [
      'source_trust',
      'sensitivity_gate',
      'dedup_check',
      'content_sanitization',
      'contradiction_check',
    ] as const) {
      expect(byType.get(t)).toBe('flag');
    }
  });

  it('has unique rule ids and every rule enabled', () => {
    const ids = RECOMMENDED_POLICY_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(RECOMMENDED_POLICY_RULES.every((r) => r.enabled)).toBe(true);
  });
});

describe('buildRecommendedPolicy', () => {
  it('produces a valid GovernancePolicy covering all rules', () => {
    const policy = buildRecommendedPolicy('team-alpha', NOW);
    expect(() => GovernancePolicy.parse(policy)).not.toThrow();
    expect(findUncoveredRuleTypes(policy)).toEqual([]);
    expect(policy.tenantId).toBe('team-alpha');
  });
});

describe('findUncoveredRuleTypes + assertPolicyCompleteness', () => {
  it('reports the dormant rules of the audited 2-rule live policy shape', () => {
    const twoRule = GovernancePolicy.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Audited live shape',
      tenantId: 'team-alpha',
      rules: [
        {
          id: 'a',
          type: 'secret_detection',
          action: 'reject',
          enabled: true,
          priority: 0,
          parameters: {},
        },
        {
          id: 'b',
          type: 'content_length',
          action: 'reject',
          enabled: true,
          priority: 1,
          parameters: { min: 25 },
        },
      ],
      enabled: true,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(findUncoveredRuleTypes(twoRule)).toEqual(
      [
        'content_sanitization',
        'contradiction_check',
        'dedup_check',
        'relevance_score',
        'sensitivity_gate',
        'source_trust',
        'tenant_match',
      ].sort(),
    );
    expect(() => assertPolicyCompleteness(twoRule)).toThrow(/dormant/);
  });

  it('treats a disabled rule as uncovered', () => {
    const policy = buildRecommendedPolicy('t', NOW);
    const withDisabled = {
      ...policy,
      rules: policy.rules.map((r) => (r.type === 'dedup_check' ? { ...r, enabled: false } : r)),
    };
    expect(findUncoveredRuleTypes(withDisabled)).toEqual(['dedup_check']);
  });

  it('passes when gaps are explicitly waived', () => {
    const twoRule = buildRecommendedPolicy('t', NOW);
    const stripped = {
      ...twoRule,
      rules: twoRule.rules.filter((r) => ['secret_detection', 'content_length'].includes(r.type)),
    };
    expect(() =>
      assertPolicyCompleteness(stripped, [
        'source_trust',
        'relevance_score',
        'sensitivity_gate',
        'dedup_check',
        'tenant_match',
        'content_sanitization',
        'contradiction_check',
      ]),
    ).not.toThrow();
  });
});

describe('PolicyPipeline.dormantRuleTypes (runtime completeness gate, 5bm.2)', () => {
  it('is empty for a full-coverage recommended policy', async () => {
    const { PolicyPipeline } = await import('../pipeline.js');
    const policy = buildRecommendedPolicy('t', NOW, '00000000-0000-4000-8000-000000000001');
    expect(new PolicyPipeline(policy).dormantRuleTypes).toEqual([]);
  });

  it('lists the 7 dormant rules of the audited 2-rule live shape', async () => {
    const { PolicyPipeline } = await import('../pipeline.js');
    const twoRule = GovernancePolicy.parse({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Audited live shape',
      tenantId: 't',
      rules: [
        {
          id: 'a',
          type: 'secret_detection',
          action: 'reject',
          enabled: true,
          priority: 0,
          parameters: {},
        },
        {
          id: 'b',
          type: 'content_length',
          action: 'reject',
          enabled: true,
          priority: 1,
          parameters: { min: 25 },
        },
      ],
      enabled: true,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(new PolicyPipeline(twoRule).dormantRuleTypes).toEqual(
      [
        'content_sanitization',
        'contradiction_check',
        'dedup_check',
        'relevance_score',
        'sensitivity_gate',
        'source_trust',
        'tenant_match',
      ].sort(),
    );
  });
});

describe('buildRecommendedPolicy determinism', () => {
  it('is fully deterministic when id is supplied', () => {
    const a = buildRecommendedPolicy('t', NOW, '33333333-3333-4333-8333-333333333333');
    const b = buildRecommendedPolicy('t', NOW, '33333333-3333-4333-8333-333333333333');
    expect(a).toEqual(b);
  });

  it('produces distinct ids when id is omitted', () => {
    const a = buildRecommendedPolicy('t', NOW);
    const b = buildRecommendedPolicy('t', NOW);
    expect(a.id).not.toBe(b.id);
  });
});
