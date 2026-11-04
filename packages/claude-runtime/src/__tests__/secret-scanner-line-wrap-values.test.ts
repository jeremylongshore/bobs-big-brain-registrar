import { describe, expect, it } from 'vitest';
import { scanForSecrets } from '../secrets/secret-scanner.js';

const payload = 'TESTONLY'.repeat(5);
const families = [
  { id: 'env-secret', prefix: 'TOKEN=' },
  { id: 'slack-token', prefix: 'xox' + 'b-' },
];

describe.each(families)('$id line-wrap value boundaries', ({ id, prefix }) => {
  const key = prefix + payload;
  const find = (text: string) => scanForSecrets(text).find((match) => match.patternId === id);

  it.each([' ', '\t'])('does not concatenate short horizontal value fragments %j', (gap) => {
    expect(
      find(`${prefix}${['abc', 'def', 'ghi', 'jkl'].join(gap)}\nNext section.`),
    ).toBeUndefined();
  });

  it('does not concatenate horizontal prefix fragments', () => {
    expect(
      find(`${prefix.slice(0, 2)} ${prefix.slice(2)}${payload}\nNext section.`),
    ).toBeUndefined();
  });

  it('preserves ordinary inline detection and source coordinates', () => {
    expect(find(`header\n${key}`)).toMatchObject({ line: 2, column: 1, matchLength: key.length });
  });

  it.each(['\n', ' \r\n    ', '\t\n\t', ' \u2028 ', '\t\u2029\t', '\r'])(
    'detects a value split by padded line-wrap whitespace %j',
    (wrap) => {
      expect(
        find(`${key.slice(0, prefix.length + 4)}${wrap}${key.slice(prefix.length + 4)}`),
      ).toBeDefined();
    },
  );

  it('detects a prefix split across lines', () => {
    expect(find(`${key.slice(0, 2)}\n${key.slice(2)}`)).toBeDefined();
  });

  it('does not let an earlier short value consume a later genuinely wrapped key', () => {
    const text = `${prefix}abc def ghi jkl\n${key.slice(0, prefix.length + 4)}\n${key.slice(prefix.length + 4)} end.`;
    expect(find(text)?.matchLength).toBe(key.length);
  });

  it('retains a wrapped key followed by ordinary prose', () => {
    expect(
      find(`${key.slice(0, prefix.length + 4)}\n${key.slice(prefix.length + 4)} and more text.`)
        ?.matchLength,
    ).toBe(key.length);
  });

  it.each(['base64', 'hex'] as const)('detects an encoded genuine key in %s', (encoding) => {
    const encoded = Buffer.from(key).toString(encoding);
    expect(
      scanForSecrets(`value: ${encoded}`).some(
        (match) => match.patternId === `${encoding}-wrapped:${id}`,
      ),
    ).toBe(true);
  });

  it('keeps many short assignments separate without candidate-suffix rescans', () => {
    expect(find((prefix + 'a ').repeat(8000) + '\n')).toBeUndefined();
  });

  it('is deterministic and emits match metadata without secret values', () => {
    const text = `${key.slice(0, prefix.length + 4)}\n${key.slice(prefix.length + 4)}`;
    const result = scanForSecrets(text);
    expect(result).toEqual(scanForSecrets(text));
    expect(result.some((match) => match.patternId === id)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(payload.slice(0, 12));
  });
});
