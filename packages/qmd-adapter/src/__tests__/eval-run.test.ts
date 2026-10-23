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

  it('reports FAMA@k and obsolete exposure from the obsolete labels', async () => {
    const dataset: EvalDataset = {
      name: 'fama',
      idSpace: 'id',
      queries: [
        { id: 'stale', query: 'q-s', relevant: ['new'], obsolete: ['old'] }, // both served
        { id: 'clean', query: 'q-c', relevant: ['d1'], obsolete: ['gone'] }, // stale kept out
        { id: 'plain', query: 'q-p', relevant: ['d2'] }, // no labels: FAMA = recall
      ],
    };
    const retrieve = mockBackend({ 'q-s': ['old', 'new'], 'q-c': ['d1'], 'q-p': ['d2'] });
    const report = await runEval(dataset, retrieve, { k: 10 });

    expect(report.perQuery.map((r) => r.famaAtK)).toEqual([0.5, 1, 1]);
    expect(report.perQuery[0]?.obsoleteRetrieved).toEqual(['old']);
    expect(report.meanRecallAtK).toBe(1);
    expect(report.meanFamaAtK).toBeCloseTo(2.5 / 3, 10);
    expect(report.obsoleteExposureRate).toBeCloseTo(1 / 3, 10);
  });

  it('passes stable scored query IDs without deriving them from text or call order', async () => {
    const seen: unknown[] = [];
    const retrieve: RetrievalFn = async (_query, _k, context) => {
      seen.push(context);
      return [];
    };
    await runEval(
      {
        ...DATASET,
        queries: DATASET.queries.map((query) => ({ ...query, query: 'same private text' })),
      },
      retrieve,
    );
    expect(seen).toEqual([
      { phase: 'scored', queryId: 'a' },
      { phase: 'scored', queryId: 'b' },
    ]);
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
