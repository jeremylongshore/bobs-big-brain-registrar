import { describe, it, expect } from 'vitest';
import { evaluateSourceTrust } from '../rules/source-trust-rule.js';
import { makeCandidate, makeContext } from './fixtures.js';

function makeRule(parameters: Record<string, unknown> = {}, action: 'reject' | 'flag' = 'reject') {
  return {
    id: 'rule-source-trust',
    type: 'source_trust' as const,
    action,
    enabled: true,
    priority: 0,
    parameters,
  };
}

describe('evaluateSourceTrust', () => {
  it('passes high trust when minimum is low', () => {
    const candidate = makeCandidate({ trustLevel: 'high' });
    const rule = makeRule({ minimumTrust: 'low' });
    const result = evaluateSourceTrust(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('pass');
    expect(result.score).toBeDefined();
    expect(result.score).toBeGreaterThan(0);
  });

  it('fails untrusted when minimum is medium', () => {
    const candidate = makeCandidate({ trustLevel: 'untrusted' });
    const rule = makeRule({ minimumTrust: 'medium' });
    const result = evaluateSourceTrust(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain('untrusted');
    expect(result.reason).toContain('medium');
  });

  it('uses default minimum of low when not specified', () => {
    // 'low' trust against default minimum 'low' — should pass
    const candidate = makeCandidate({ trustLevel: 'low' });
    const rule = makeRule({});
    const result = evaluateSourceTrust(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('pass');
  });

  it('handles all trust levels in correct order', () => {
    const levels = ['untrusted', 'low', 'medium', 'high'] as const;
    // With minimumTrust='medium', only medium and high should pass
    for (const level of levels) {
      const candidate = makeCandidate({ trustLevel: level });
      const rule = makeRule({ minimumTrust: 'medium' });
      const result = evaluateSourceTrust(candidate, rule, makeContext(candidate));
      if (level === 'medium' || level === 'high') {
        expect(result.outcome).toBe('pass');
      } else {
        expect(result.outcome).toBe('fail');
      }
    }
  });

  it('returns a trust score on pass', () => {
    const candidate = makeCandidate({ trustLevel: 'high' });
    const rule = makeRule({ minimumTrust: 'low' });
    const result = evaluateSourceTrust(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('pass');
    // high = 4/4 = 1.0
    expect(result.score).toBeCloseTo(1.0, 5);
  });

  it('uses rule.action to determine fail outcome: flag action yields flag outcome', () => {
    const candidate = makeCandidate({ trustLevel: 'untrusted' });
    const rule = makeRule({ minimumTrust: 'high' }, 'flag');
    const result = evaluateSourceTrust(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('flag');
  });
});

describe('evaluateSourceTrust — bulk_import gating (5bm.8)', () => {
  it('fails a bulk_import candidate stamped untrusted (below the default low minimum)', () => {
    // untrusted (1) < default minimumTrust 'low' (2) → the rule fails, so a
    // source_trust rule with action 'flag' (the recommended policy) gates the
    // whole-machine digestion for review instead of promoting it silently.
    const candidate = makeCandidate({ source: 'bulk_import', trustLevel: 'untrusted' });
    const rule = makeRule({});
    const result = evaluateSourceTrust(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
  });

  it('passes a normal import at the default medium trust', () => {
    const candidate = makeCandidate({ source: 'import', trustLevel: 'medium' });
    const rule = makeRule({});
    expect(evaluateSourceTrust(candidate, rule, makeContext(candidate)).outcome).toBe('pass');
  });
});
