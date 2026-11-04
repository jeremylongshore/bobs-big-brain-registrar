import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { scanForSecrets } from '../secrets/secret-scanner.js';
import { SECRET_PATTERNS } from '../secrets/patterns.js';

const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const hero = 'heroku-api-key';
const hits = (text: string) => scanForSecrets(text).filter((m) => m.patternId.endsWith(hero));

describe('Heroku UUID source-associated context', () => {
  it('does not feed a synthetic clipping guard to a custom context predicate', () => {
    const original = SECRET_PATTERNS.find((p) => p.id === hero)!;
    const pattern = { ...original, requiresContext: /0/g };
    const value = '11111111-1111-1111-1111-111111111111';
    expect(scanForSecrets(`${'A'.repeat(300)} key:\n${value}`, [pattern])).toEqual([]);
  });
  it.each([252, 253])(
    'does not manufacture a credential-word boundary with %i padding',
    (padding) => {
      expect(hits(`monkey:${' '.repeat(padding)}\n${uuid}`)).toEqual([]);
    },
  );
  it.each([
    { suffix: '', expected: 0 },
    { suffix: ' key:', expected: 1 },
  ])('bounds context work after a long identifier with suffix $suffix', ({ suffix, expected }) => {
    const moduleUrl = new URL('../../dist/secrets/secret-scanner.js', import.meta.url).href;
    const script = `import { scanForSecrets } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify(scanForSecrets('A'.repeat(100000) + ${JSON.stringify(suffix)} + '\\n' + ${JSON.stringify(uuid)})));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 2000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(expected);
  });
  it.each(
    ['API guide:', 'API_REQUEST_ID=', 'TRACE_ID='].flatMap((label) =>
      (['raw', 'base64', 'hex'] as const).map((encoding) => ({ label, encoding })),
    ),
  )('does not treat $label as a credential label for $encoding', ({ label, encoding }) => {
    const value = encoding === 'raw' ? uuid : Buffer.from(uuid).toString(encoding);
    expect(hits(`${label}\n${value}`)).toEqual([]);
  });

  it.each(['TOKEN=', 'PASSWORD=', 'Heroku key is', 'credential:'])(
    'retains a credential-specific preceding label %s',
    (label) => expect(hits(`${label}\n${uuid}`)).not.toEqual([]),
  );
  it('keeps a long failed label suffix separate from the following UUID', () => {
    expect(hits(`Heroku key${' '.repeat(16000)}x\n${uuid}`)).toEqual([]);
  });

  it('returns only stable match metadata for a labeled wrapped fixture', () => {
    const content = `Heroku API key: ${uuid.slice(0, 14)}\n${uuid.slice(14)}`;
    const first = hits(content);
    expect(first).toEqual(hits(content));
    expect(first).toHaveLength(1);
    expect(Object.keys(first[0]!).sort()).toEqual([
      'column',
      'line',
      'matchLength',
      'patternId',
      'patternName',
    ]);
    expect(JSON.stringify(first)).not.toContain(uuid.slice(0, 14));
  });
  it('does not spend the decode budget again on repeated context-sensitive blobs', () => {
    const blob = Buffer.from(uuid).toString('base64');
    const key = 'sk-' + 'TESTONLY'.repeat(5);
    const wrappedKey = Buffer.from(key).toString('base64');
    const content = `${`Request ${blob}\n`.repeat(100)}real blob ${wrappedKey}`;
    expect(
      scanForSecrets(content).some((m) => m.patternId === 'base64-wrapped:generic-api-key'),
    ).toBe(true);
  });
  it.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])(
    'does not borrow API-guide context across separator %j',
    (gap) => expect(hits(`API guide${gap}The request id was ${uuid}`)).toEqual([]),
  );

  it('does not borrow context from a later unrelated line', () => {
    expect(hits(`Tracked in bead ${uuid}\nAPI guide`)).toEqual([]);
  });

  it.each(['HEROKU_API_KEY=', 'Heroku API key:', 'HEROKU_API_KEY set to', 'Heroku API key'])(
    'preserves an explicit preceding label %s',
    (label) => expect(hits(`${label}\n${uuid}`)).not.toEqual([]),
  );

  it.each(['\n', ' \r\n  ', '\t\u2028 ', '\t\u2029\t'])(
    'preserves associated split UUIDs with padded wrap %j',
    (gap) => {
      expect(hits(`Heroku API key: ${uuid.slice(0, 14)}${gap}${uuid.slice(14)}`)).not.toEqual([]);
    },
  );

  it('rejects an unrelated earlier UUID and locates the later wrapped credential', () => {
    const content = `API guide\nrequest ${uuid}\nHeroku API key: ${uuid.slice(0, 14)}\n${uuid.slice(14)}`;
    expect(hits(content)).toEqual([
      expect.objectContaining({ patternId: hero, line: 3, column: 17, matchLength: 36 }),
    ]);
  });

  it.each(['base64', 'hex'] as const)('does not lend unrelated context to %s UUIDs', (encoding) => {
    const blob = Buffer.from(uuid).toString(encoding);
    expect(hits(`API guide\nThe request blob was ${blob}`)).toEqual([]);
  });

  it.each(['base64', 'hex'] as const)(
    'evaluates each repeated %s occurrence in its own context',
    (encoding) => {
      const blob = Buffer.from(uuid).toString(encoding);
      expect(hits(`Request blob ${blob}\nThe Heroku API key blob is ${blob}`)).toEqual([
        expect.objectContaining({ patternId: `${encoding}-wrapped:${hero}`, line: 2, column: 28 }),
      ]);
    },
  );

  it.each(['base64', 'hex'] as const)('keeps context inside a decoded %s value', (encoding) => {
    const blob = Buffer.from(`HEROKU_API_KEY=${uuid}`).toString(encoding);
    expect(
      hits(`Stored blob ${blob}`).some((m) => m.patternId === `${encoding}-wrapped:${hero}`),
    ).toBe(true);
  });

  it('keeps same-line keyword ambiguity suspicious', () => {
    expect(hits(`API guide uses request ${uuid}`)).not.toEqual([]);
  });

  it.each(['g', 'y'])('resets context regex state with flag %s', (flag) => {
    const original = SECRET_PATTERNS.find((p) => p.id === hero)!;
    const pattern = { ...original, requiresContext: new RegExp('Heroku', flag) };
    const content = `Other words\nHeroku key: ${uuid}`;
    const first = scanForSecrets(content, [pattern]);
    expect(first).not.toEqual([]);
    expect(scanForSecrets(content, [pattern])).toEqual(first);
  });

  it('preserves unrelated context-free secret detection', () => {
    const key = 'sk-' + 'TESTONLY'.repeat(5);
    const result = scanForSecrets(`API guide\nrequest ${uuid}\n${key}`);
    expect(result.some((m) => m.patternId === hero)).toBe(false);
    expect(result.some((m) => m.patternId === 'generic-api-key')).toBe(true);
  });
});
