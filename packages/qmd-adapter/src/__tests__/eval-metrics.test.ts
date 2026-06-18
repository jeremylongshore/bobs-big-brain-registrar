import { describe, it, expect } from 'vitest';
import { recallAtK, ndcgAtK, reciprocalRank } from '../eval/metrics.js';

const S = (...ids: string[]): Set<string> => new Set(ids);

describe('recallAtK', () => {
  it('is 1.0 when all relevant docs are in the top-k', () => {
    expect(recallAtK(['a', 'b', 'c'], S('a', 'c'), 3)).toBe(1);
  });

  it('is the fraction of relevant docs found', () => {
    expect(recallAtK(['a', 'b', 'c'], S('a', 'x'), 3)).toBe(0.5);
  });

  it('is 0 when none of the relevant docs are retrieved', () => {
    expect(recallAtK(['a', 'b'], S('x'), 2)).toBe(0);
  });

  it('respects the k cutoff', () => {
    expect(recallAtK(['x', 'a'], S('a'), 1)).toBe(0);
    expect(recallAtK(['x', 'a'], S('a'), 2)).toBe(1);
  });

  it('credits a relevant doc once even if retrieval repeats it', () => {
    expect(recallAtK(['a', 'a'], S('a'), 2)).toBe(1);
  });

  it('is 0 when there are no relevant docs', () => {
    expect(recallAtK(['a', 'b'], S(), 2)).toBe(0);
  });
});

describe('ndcgAtK', () => {
  it('is 1.0 for a perfect ranking', () => {
    expect(ndcgAtK(['a', 'b'], S('a', 'b'), 2)).toBe(1);
  });

  it('is 1.0 for a single relevant doc at rank 1', () => {
    expect(ndcgAtK(['a', 'b'], S('a'), 2)).toBe(1);
  });

  it('discounts a relevant doc at rank 2 (1/log2(3) normalized by ideal 1)', () => {
    expect(ndcgAtK(['x', 'a'], S('a'), 2)).toBeCloseTo(1 / Math.log2(3), 10);
  });

  it('is 0 when nothing relevant is retrieved', () => {
    expect(ndcgAtK(['x', 'y'], S('a'), 2)).toBe(0);
  });

  it('credits a repeated relevant doc once at its earliest rank', () => {
    expect(ndcgAtK(['a', 'a'], S('a'), 2)).toBe(1);
  });

  it('normalizes by the ideal DCG capped at k', () => {
    // 2 relevant, retrieved one at rank 1 and the other beyond k=1.
    // DCG@1 = 1/log2(2) = 1; IDCG@1 (ideal, 1 slot) = 1 → nDCG = 1.0
    expect(ndcgAtK(['a', 'z', 'b'], S('a', 'b'), 1)).toBe(1);
    // at k=2: DCG = 1/log2(2) (a@1) = 1; IDCG@2 (2 relevant) = 1 + 1/log2(3)
    const idcg2 = 1 + 1 / Math.log2(3);
    expect(ndcgAtK(['a', 'z', 'b'], S('a', 'b'), 2)).toBeCloseTo(1 / idcg2, 10);
  });

  it('is 0 when there are no relevant docs', () => {
    expect(ndcgAtK(['a'], S(), 5)).toBe(0);
  });
});

describe('reciprocalRank', () => {
  it('is 1 / (rank of the first relevant doc)', () => {
    expect(reciprocalRank(['x', 'a', 'b'], S('a'))).toBe(0.5);
    expect(reciprocalRank(['a', 'b'], S('a'))).toBe(1);
  });

  it('is 0 when no relevant doc is retrieved', () => {
    expect(reciprocalRank(['x', 'y'], S('a'))).toBe(0);
  });
});
