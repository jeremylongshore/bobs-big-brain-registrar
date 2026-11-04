import { describe, it, expect } from 'vitest';
import { evaluateSecretDetection } from '../rules/secret-detection-rule.js';
import { makeCandidate, makeContext } from './fixtures.js';

function makeRule(overrides?: Record<string, unknown>) {
  return {
    id: 'rule-secret-detection',
    type: 'secret_detection' as const,
    action: 'reject' as const,
    enabled: true,
    priority: 0,
    parameters: {},
    ...overrides,
  };
}

describe('evaluateSecretDetection', () => {
  it('detects JWT tokens in content', () => {
    const content =
      'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const candidate = makeCandidate({ content });
    const rule = makeRule();
    const result = evaluateSecretDetection(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain('jwt');
  });

  it('detects AWS access keys', () => {
    const content = 'aws_key = AKIAIOSFODNN7EXAMPLE';
    const candidate = makeCandidate({ content });
    const rule = makeRule();
    const result = evaluateSecretDetection(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain('aws-key');
  });

  it('detects GitHub tokens', () => {
    const content = 'GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
    const candidate = makeCandidate({ content });
    const rule = makeRule();
    const result = evaluateSecretDetection(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain('github-token');
  });

  it('detects generic API keys (sk-*)', () => {
    const content = 'api_key: sk-abcdefghijklmnopqrstuvwxyz';
    const candidate = makeCandidate({ content });
    const rule = makeRule();
    const result = evaluateSecretDetection(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain('generic-api-key');
  });

  it.each([
    'Task-Based Gameplay improves player feedback and progression',
    'risk-level classification needs careful handling',
    'per-task-family evaluation measures generalization',
  ])('passes multiline prose without a manufactured key: %s', (prose) => {
    const candidate = makeCandidate({ content: `${prose}\nNext section covers evaluation.` });
    expect(evaluateSecretDetection(candidate, makeRule(), makeContext(candidate)).outcome).toBe(
      'pass',
    );
  });

  it('rejects a real split key after benign joined-word prose without leaking its value', () => {
    const key = 'sk-' + 'TESTONLY'.repeat(5);
    const candidate = makeCandidate({
      content: `Task-Based Gameplay improves player feedback and progression\nThe key is ${key.slice(0, 12)}\n${key.slice(12)}`,
    });
    const result = evaluateSecretDetection(candidate, makeRule(), makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain('generic-api-key');
    expect(result.reason).not.toContain(key.slice(3, 12));
  });

  it('rejects a horizontally fragmented key starting after an unrelated prose line', () => {
    const key = 'sk-' + 'TESTONLY'.repeat(5);
    const candidate = makeCandidate({
      content: `Unrelated preceding prose\n${key.slice(0, 12)} ${key.slice(12)}`,
    });
    const result = evaluateSecretDetection(candidate, makeRule(), makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain('generic-api-key');
    expect(result.reason).not.toContain(key.slice(3, 12));
  });

  it('passes clean content', () => {
    const candidate = makeCandidate({
      content: 'Use Result<T, E> for all fallible operations in the codebase.',
    });
    const rule = makeRule();
    const result = evaluateSecretDetection(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('pass');
    expect(result.ruleId).toBe(rule.id);
  });

  it.each(['raw', 'base64'] as const)(
    'passes an unrelated API-guide line and a %s UUID',
    (encoding) => {
      const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
      const value = encoding === 'raw' ? uuid : Buffer.from(uuid).toString('base64');
      const candidate = makeCandidate({ content: `API guide\nRequest id ${value}` });
      expect(evaluateSecretDetection(candidate, makeRule(), makeContext(candidate)).outcome).toBe(
        'pass',
      );
    },
  );

  it.each(['raw', 'base64'] as const)(
    'rejects a labeled %s UUID with metadata-only reasoning',
    (encoding) => {
      const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
      const value = encoding === 'raw' ? uuid : Buffer.from(uuid).toString('base64');
      const candidate = makeCandidate({ content: `HEROKU_API_KEY set to\n${value}` });
      const result = evaluateSecretDetection(candidate, makeRule(), makeContext(candidate));
      expect(result.outcome).toBe('fail');
      expect(result.reason).toContain('heroku-api-key');
      expect(result.reason).not.toContain(uuid);
      expect(result.reason).not.toContain(value);
    },
  );

  it.each(['TOKEN=abc def ghi jkl', 'xox' + 'b-abc def ghi jkl'])(
    'passes short horizontal value fragments: %s',
    (text) => {
      const candidate = makeCandidate({ content: `${text}\nNext section.` });
      expect(evaluateSecretDetection(candidate, makeRule(), makeContext(candidate)).outcome).toBe(
        'pass',
      );
    },
  );

  it.each([
    { id: 'env-secret', prefix: 'TOKEN=' },
    { id: 'slack-token', prefix: 'xox' + 'b-' },
  ])('rejects a genuinely wrapped $id without exposing the value', ({ id, prefix }) => {
    const payload = 'TESTONLY'.repeat(5);
    const candidate = makeCandidate({
      content: `${prefix}${payload.slice(0, 4)}\n    ${payload.slice(4)} and more text.`,
    });
    const result = evaluateSecretDetection(candidate, makeRule(), makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain(id);
    expect(result.reason).not.toContain(payload.slice(0, 12));
  });

  it('includes pattern ids in failure reason', () => {
    const content = 'AWS_KEY=AKIAIOSFODNN7EXAMPLE';
    const candidate = makeCandidate({ content });
    const rule = makeRule();
    const result = evaluateSecretDetection(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain('aws-key');
    expect(result.reason).toContain('AWS Access Key');
  });

  it('handles multiple secrets in the same content', () => {
    const content = [
      'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
      'GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
    ].join('\n');
    const candidate = makeCandidate({ content });
    const rule = makeRule();
    const result = evaluateSecretDetection(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain('aws-key');
    expect(result.reason).toContain('github-token');
  });

  it('passes content that is effectively clean despite length', () => {
    // Long clean content — should not trigger any pattern
    const content = 'Always use const for variables that are never reassigned. '.repeat(10);
    const candidate = makeCandidate({ content });
    const rule = makeRule();
    const result = evaluateSecretDetection(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('pass');
  });
});
