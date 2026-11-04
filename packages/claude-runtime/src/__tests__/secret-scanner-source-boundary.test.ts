import { describe, expect, it } from 'vitest';
import { scanForSecrets } from '../secrets/secret-scanner.js';

const key = 'sk-' + 'abcdefghijKLMNOPqrstuvwxyz1234567890';
const hasApiKey = (text: string) =>
  scanForSecrets(text).some((match) => match.patternId === 'generic-api-key');

describe('whitespace-stripped API keys preserve source token boundaries', () => {
  it.each([
    'Task-Based Gameplay improves player feedback and progression',
    'risk-level classification needs careful handling',
    'per-task-family evaluation measures generalization',
    'desk-level configuration requires explicit documentation',
  ])('does not manufacture a key inside prose: %s', (prose) => {
    expect(scanForSecrets(`${prose}\nNext section covers evaluation.`)).toEqual([]);
  });

  it.each(['', 'The key is ', 'key: ', 'TOKEN=', '"', '\n', '\t', '('])(
    'still detects a genuinely split key after source delimiter %j',
    (prefix) => {
      const split = `${key.slice(0, 12)}\n${key.slice(12)}`;
      expect(hasApiKey(`${prefix}${split}`)).toBe(true);
    },
  );

  it('still detects a key with an indented wrapped continuation', () => {
    expect(hasApiKey(`The key is ${key.slice(0, 12)}\n    ${key.slice(12)}`)).toBe(true);
  });

  it('does not let an earlier false match hide a later genuinely split key', () => {
    const prose = 'Task-Based Gameplay improves player feedback and progression';
    expect(hasApiKey(`${prose}.\nThe credential is ${key.slice(0, 12)}\n${key.slice(12)}`)).toBe(
      true,
    );
  });

  it('finds a later real prefix even when an earlier rejected match consumes its first letters', () => {
    const prose = 'Task-Based Gameplay improves player feedback and progression';
    expect(hasApiKey(`${prose}\nThe credential is ${key.slice(0, 12)}\n${key.slice(12)}`)).toBe(
      true,
    );
  });

  it('preserves exact source coordinates for ordinary inline keys', () => {
    const match = scanForSecrets(`header\nkey: ${key}`).find(
      (item) => item.patternId === 'generic-api-key',
    );
    expect(match).toMatchObject({ line: 2, column: 6, matchLength: key.length });
  });

  it('retains detection of a base64-wrapped genuine key', () => {
    const encoded = Buffer.from(key).toString('base64');
    expect(
      scanForSecrets(`wrapped value: ${encoded}\nsecond line`).some(
        (match) => match.patternId === 'base64-wrapped:generic-api-key',
      ),
    ).toBe(true);
  });

  it('is deterministic and emits only match metadata', () => {
    const text = `The key is ${key.slice(0, 12)}\n${key.slice(12)}`;
    const result = scanForSecrets(text);
    expect(result).toEqual(scanForSecrets(text));
    expect(JSON.stringify(result)).not.toContain(key.slice(3, 12));
  });
});
