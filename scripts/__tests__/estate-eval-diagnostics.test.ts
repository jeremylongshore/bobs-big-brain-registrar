import { describe, expect, it } from 'vitest';
import { classifyDenseFailure } from '../lib/estate-eval-diagnostics.js';

describe('estate evaluation diagnostics', () => {
  it.each([
    ['dense arm unavailable after construction', 'construction-unavailable'],
    ['dense index is empty or unbuilt', 'unbuilt-or-empty'],
    ['query vector dimension does not match dense index', 'dimension-mismatch'],
  ])('classifies %s', (message, category) => {
    expect(classifyDenseFailure(new Error(message))).toBe(category);
  });
  it('never copies unknown error payloads into the report', () => {
    const canary = 'PRIVATE-DIAGNOSTIC-CANARY';
    for (const error of [new Error(canary), canary, { message: canary }, null]) {
      expect(classifyDenseFailure(error)).toBe('query-failure');
      expect(classifyDenseFailure(error)).not.toContain(canary);
    }
  });
});
