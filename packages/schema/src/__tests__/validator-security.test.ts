import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContentMetadata } from '../common.js';

describe('bounded collection validation security', () => {
  it('rejects oversized arrays before child parsing, synchronously and asynchronously', async () => {
    let visits = 0;
    const schema = z.object({
      values: z
        .array(
          z.string().refine(() => {
            visits++;
            return true;
          }),
        )
        .max(2),
    });
    const oversized = { values: Array.from({ length: 64 }, () => 'valid') };
    for (const result of [schema.safeParse(oversized), await schema.safeParseAsync(oversized)]) {
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toMatchObject([{ code: 'too_big', path: ['values'] }]);
    }
    expect(visits).toBe(0);
    expect(schema.parse({ values: ['a', 'b'] })).toEqual({ values: ['a', 'b'] });
    expect(visits).toBe(2);
  });

  it('rejects oversized sets and maps before visiting elements, keys or values', () => {
    let visits = 0;
    const element = z.string().refine(() => {
      visits++;
      return true;
    });
    expect(
      z
        .set(element)
        .max(2)
        .safeParse(new Set(['a', 'b', 'c'])).success,
    ).toBe(false);
    expect(
      z
        .map(element, element)
        .max(2)
        .safeParse(
          new Map([
            ['a', 'one'],
            ['b', 'two'],
            ['c', 'three'],
          ]),
        ).success,
    ).toBe(false);
    expect(visits).toBe(0);
    expect(
      z
        .set(element)
        .max(2)
        .parse(new Set(['a', 'b'])),
    ).toEqual(new Set(['a', 'b']));
    expect(
      z
        .map(element, element)
        .max(2)
        .parse(new Map([['a', 'one']])),
    ).toEqual(new Map([['a', 'one']]));
    expect(visits).toBe(4);
  });

  it('preserves the actual eight-subject metadata boundary and existing defaults', () => {
    const subjects = Array.from({ length: 8 }, (_, i) => `fixture.subject-${i}`);
    expect(ContentMetadata.parse({ subjects })).toEqual({ filePaths: [], tags: [], subjects });
    expect(ContentMetadata.safeParse({ subjects: [...subjects, 'fixture.extra'] }).success).toBe(
      false,
    );
  });
});
