import { describe, expect, it } from 'vitest';
import type { Sensitivity } from '@qmd-team-intent-kb/schema';
import { effectiveSensitivity } from '../sensitivity-constraint.js';

const levels: Sensitivity[] = ['public', 'internal', 'confidential', 'restricted'];
const expected: Sensitivity[][] = [
  ['public', 'internal', 'confidential', 'restricted'],
  ['internal', 'internal', 'confidential', 'restricted'],
  ['confidential', 'confidential', 'confidential', 'restricted'],
  ['restricted', 'restricted', 'restricted', 'restricted'],
];

describe('effective reviewed sensitivity', () => {
  it.each(
    levels.flatMap((classified, row) =>
      levels.map((minimum, column) => ({
        classified,
        minimum,
        effective: expected[row]![column]!,
      })),
    ),
  )(
    'keeps $classified with minimum $minimum at $effective',
    ({ classified, minimum, effective }) => {
      expect(effectiveSensitivity(classified, minimum)).toBe(effective);
    },
  );

  it.each(levels)('keeps %s without a floor', (classified) => {
    expect(effectiveSensitivity(classified)).toBe(classified);
  });

  it.each(['unknown', '', null, 99])('refuses invalid runtime minimum %s', (minimum) => {
    expect(() => effectiveSensitivity('public', minimum as Sensitivity)).toThrow();
  });
});
