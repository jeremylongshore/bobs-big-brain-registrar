import { describe, it, expect } from 'vitest';
import { runEval, formatReport, bm25IsSufficient } from '../eval/run-eval.js';
import { SEED_EVAL_DATASET } from '../eval/datasets/seed-queries.js';
import type { EvalDataset, RetrievalFn } from '../eval/eval-types.js';

/** A deterministic mock backend: returns a fixed ranked list per query. */
function mockBackend(table: Record<string, string[]>): RetrievalFn {
  return (query: string, k: number) => Promise.resolve((table[query] ?? []).slice(0, k));
}

const DATASET: EvalDataset = {
  name: 'unit',
  idSpace: 'id',
  queries: [
    { id: 'a', query: 'q-a', relevant: ['d1'], kind: 'lexical' }, // perfect: d1 @ rank 1
    { id: 'b', query: 'q-b', relevant: ['d2'], kind: 'semantic' }, // miss: d2 not retrieved
  ],
};

describe('runEval', () => {
  it('computes per-query metrics and the means across the dataset', async () => {
    const retrieve = mockBackend({ 'q-a': ['d1', 'x'], 'q-b': ['x', 'y'] });
    const report = await runEval(DATASET, retrieve, { k: 10, backend: 'mock' });

    expect(report.backend).toBe('mock');
    expect(report.k).toBe(10);
    expect(report.queryCount).toBe(2);

    const a = report.perQuery.find((r) => r.id === 'a');
    const b = report.perQuery.find((r) => r.id === 'b');
    expect(a?.recallAtK).toBe(1);
    expect(a?.ndcgAtK).toBe(1);
    expect(b?.recallAtK).toBe(0);
    expect(b?.ndcgAtK).toBe(0);

    // means of [1, 0]
    expect(report.meanRecallAtK).toBe(0.5);
    expect(report.meanNdcgAtK).toBe(0.5);
  });

  it('passes the k cutoff through to the backend', async () => {
    const seen: number[] = [];
    const retrieve: RetrievalFn = (_q, k) => {
      seen.push(k);
      return Promise.resolve(['d1']);
    };
    await runEval(DATASET, retrieve, { k: 3 });
    expect(seen).toEqual([3, 3]);
  });

  it('defaults k to 10 and backend to "unknown"', async () => {
    const report = await runEval(DATASET, mockBackend({}), {});
    expect(report.k).toBe(10);
    expect(report.backend).toBe('unknown');
    expect(report.meanRecallAtK).toBe(0); // nothing retrieved
  });

  it('scores the seed dataset perfectly when the backend returns the gold docs', async () => {
    const oracle: RetrievalFn = (query, k) => {
      const q = SEED_EVAL_DATASET.queries.find((x) => x.query === query);
      return Promise.resolve((q?.relevant ?? []).slice(0, k));
    };
    const report = await runEval(SEED_EVAL_DATASET, oracle, { k: 10, backend: 'oracle' });
    expect(report.queryCount).toBe(SEED_EVAL_DATASET.queries.length);
    expect(report.meanRecallAtK).toBe(1);
    expect(report.meanNdcgAtK).toBe(1);
  });
});

describe('formatReport', () => {
  it('renders the dataset, backend, and both mean metrics', async () => {
    const report = await runEval(DATASET, mockBackend({ 'q-a': ['d1'] }), {
      k: 10,
      backend: 'mock',
    });
    const out = formatReport(report);
    expect(out).toContain('backend=mock');
    expect(out).toContain('mean Recall@10 = 0.5000');
    expect(out).toContain('mean nDCG@10   = 0.5000');
  });
});

describe('bm25IsSufficient', () => {
  const report = (meanRecallAtK: number) => ({
    dataset: 'd',
    backend: 'bm25',
    k: 10,
    queryCount: 1,
    meanRecallAtK,
    meanNdcgAtK: 0,
    perQuery: [],
  });

  it('is true at or above the 0.85 threshold', () => {
    expect(bm25IsSufficient(report(0.9))).toBe(true);
    expect(bm25IsSufficient(report(0.85))).toBe(true);
  });

  it('is false below the threshold', () => {
    expect(bm25IsSufficient(report(0.8499))).toBe(false);
  });
});
