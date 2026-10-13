import { describe, it, expect } from 'vitest';
import { recallAtK, ndcgAtK, reciprocalRank, famaAtK } from '../eval/metrics.js';

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

describe('famaAtK', () => {
  it('equals Recall@k when no obsolete docs are labeled', () => {
    const r = famaAtK(['a', 'x', 'b'], S('a', 'c'), S(), 3);
    expect(r).toEqual({ mpa: 0.5, faa: 1, lambda: 0, fama: 0.5, obsoleteRetrieved: [] });
  });

  it('is 1.0 when the valid doc is found and every obsolete doc is kept out', () => {
    expect(famaAtK(['a', 'x'], S('a'), S('old'), 2).fama).toBe(1);
  });

  it('subtracts lambda for each obsolete doc in the top-k', () => {
    // valid a found (MPA 1); obsolete o1 retrieved, o2 not (FAA 0.5); lambda 2/3.
    const r = famaAtK(['o1', 'a', 'z'], S('a'), S('o1', 'o2'), 3);
    expect(r.mpa).toBe(1);
    expect(r.faa).toBe(0.5);
    expect(r.lambda).toBeCloseTo(2 / 3, 10);
    expect(r.fama).toBeCloseTo(1 - (2 / 3) * 0.5, 10);
    expect(r.obsoleteRetrieved).toEqual(['o1']);
  });

  it('clamps at 0 when only obsolete docs are retrieved', () => {
    const r = famaAtK(['o1', 'o2'], S('a'), S('o1'), 2);
    expect(r.fama).toBe(0);
    expect(r.mpa).toBe(0);
  });

  it('ignores obsolete docs ranked below the k cutoff', () => {
    expect(famaAtK(['a', 'b', 'o1'], S('a'), S('o1'), 2).fama).toBe(1);
  });

  it('counts a repeated obsolete doc once', () => {
    const r = famaAtK(['o1', 'o1', 'a'], S('a'), S('o1', 'o2'), 3);
    expect(r.obsoleteRetrieved).toEqual(['o1']);
    expect(r.faa).toBe(0.5);
  });

  it('scores a recall-perfect brain below 1 when it also serves the stale doc', () => {
    // The failure Recall@k cannot see: the right answer AND the torn-down one.
    const recall = recallAtK(['gcp-runbook', 'vps-runbook'], S('vps-runbook'), 10);
    const fama = famaAtK(['gcp-runbook', 'vps-runbook'], S('vps-runbook'), S('gcp-runbook'), 10);
    expect(recall).toBe(1);
    expect(fama.fama).toBe(0.5);
  });
});
