import { describe, it, expect } from 'vitest';

import { stratify, formatStratifiedReport } from '../eval/stratified-report.js';
import type { EvalReport, EvalQuery } from '../eval/eval-types.js';

const QUERIES: EvalQuery[] = [
  { id: 'lex1', query: 'q-lex1', relevant: ['d1'], kind: 'lexical' }, // d1 @ rank 1 → perfect
  { id: 'lex2', query: 'q-lex2', relevant: ['d2'], kind: 'lexical' }, // d2 @ rank 2
  { id: 'sem1', query: 'q-sem1', relevant: ['d3'], kind: 'semantic' }, // miss
  { id: 'unt1', query: 'q-unt1', relevant: ['d4'], kind: undefined }, // untagged, d4 @ rank 1
];

const REPORT: EvalReport = {
  dataset: 'test',
  backend: 'mock',
  k: 10,
  queryCount: 4,
  meanRecallAtK: 0, // not used by stratify
  meanNdcgAtK: 0,
  perQuery: [
    {
      id: 'lex1',
      query: 'q-lex1',
      kind: 'lexical',
      retrieved: ['d1', 'x'],
      recallAtK: 1,
      ndcgAtK: 1,
    },
    {
      id: 'lex2',
      query: 'q-lex2',
      kind: 'lexical',
      retrieved: ['x', 'd2'],
      recallAtK: 1,
      ndcgAtK: 0.6309,
    },
    {
      id: 'sem1',
      query: 'q-sem1',
      kind: 'semantic',
      retrieved: ['x', 'y'],
      recallAtK: 0,
      ndcgAtK: 0,
    },
    { id: 'unt1', query: 'q-unt1', kind: undefined, retrieved: ['d4'], recallAtK: 1, ndcgAtK: 1 },
  ],
};

describe('stratify', () => {
  it('splits metrics by kind plus an overall row', () => {
    const sr = stratify(REPORT, QUERIES);

    expect(sr.dataset).toBe('test');
    expect(sr.backend).toBe('mock');
    expect(sr.k).toBe(10);

    expect(sr.overall.queryCount).toBe(4);
    // overall mean recall = (1 + 1 + 0 + 1) / 4
    expect(sr.overall.meanRecallAtK).toBeCloseTo(0.75, 4);

    const lexical = sr.byKind.find((s) => s.stratum === 'lexical');
    const semantic = sr.byKind.find((s) => s.stratum === 'semantic');
    const untagged = sr.byKind.find((s) => s.stratum === 'untagged');

    expect(lexical?.queryCount).toBe(2);
    expect(lexical?.meanRecallAtK).toBe(1); // both found
    expect(semantic?.queryCount).toBe(1);
    expect(semantic?.meanRecallAtK).toBe(0); // missed
    expect(untagged?.queryCount).toBe(1);
    expect(untagged?.stratum).toBe('untagged');
  });

  it('computes MRR from the retrieved lists and gold sets', () => {
    const sr = stratify(REPORT, QUERIES);
    const lexical = sr.byKind.find((s) => s.stratum === 'lexical');
    // lex1: first relevant at rank 1 → RR 1; lex2: rank 2 → RR 0.5; mean = 0.75
    expect(lexical?.mrr).toBeCloseTo(0.75, 4);

    const semantic = sr.byKind.find((s) => s.stratum === 'semantic');
    expect(semantic?.mrr).toBe(0); // never retrieved
  });

  it('sums strata counts back to the whole', () => {
    const sr = stratify(REPORT, QUERIES);
    const summed = sr.byKind.reduce((n, s) => n + s.queryCount, 0);
    expect(summed).toBe(sr.overall.queryCount);
  });

  it('treats a query id with no matching gold entry as zero reciprocal rank', () => {
    // Report references an id absent from the queries list → empty gold set.
    const orphan: EvalReport = {
      ...REPORT,
      queryCount: 1,
      perQuery: [
        { id: 'ghost', query: 'q', kind: 'semantic', retrieved: ['d1'], recallAtK: 0, ndcgAtK: 0 },
      ],
    };
    const sr = stratify(orphan, QUERIES);
    expect(sr.overall.mrr).toBe(0);
  });
});

describe('formatStratifiedReport', () => {
  it('renders the overall row and one line per kind', () => {
    const out = formatStratifiedReport(stratify(REPORT, QUERIES));
    expect(out).toContain('backend=mock');
    expect(out).toContain('overall');
    expect(out).toContain('lexical');
    expect(out).toContain('semantic');
    expect(out).toContain('Recall@10=');
    expect(out).toContain('MRR=');
  });
});
