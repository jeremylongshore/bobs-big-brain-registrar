import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Fts5Backend, fts5RetrievalFn, buildFts5MatchQuery } from '../native/fts5-backend.js';
import { runEval } from '../eval/run-eval.js';
import type { EvalDataset } from '../eval/eval-types.js';

describe('buildFts5MatchQuery', () => {
  it('quotes each word token and joins with implicit AND', () => {
    expect(buildFts5MatchQuery('security audit')).toBe('"security" "audit"');
  });

  it('neutralizes FTS5 operators and punctuation (no injection / syntax error)', () => {
    expect(buildFts5MatchQuery('foo AND bar OR (baz*) "qux"')).toBe(
      '"foo" "AND" "bar" "OR" "baz" "qux"',
    );
  });

  it('returns empty string when there are no usable tokens', () => {
    expect(buildFts5MatchQuery('   --- ')).toBe('');
  });
});

describe('Fts5Backend', () => {
  let fts: Fts5Backend;

  beforeEach(() => {
    fts = new Fts5Backend();
    // d1 and d2 both contain "security" + "audit"; d2 repeats "audit" (same length, 5 tokens).
    fts.index([
      { id: 'd1', collection: 'kb', content: 'security audit log review notes' },
      { id: 'd2', collection: 'kb', content: 'security audit audit findings report' },
      { id: 'd3', collection: 'kb', content: 'cooking recipes for dinner now' },
    ]);
  });

  afterEach(() => fts.close());

  it('indexes documents and reports the count', () => {
    expect(fts.count()).toBe(3);
  });

  it('returns only docs that match the keywords', () => {
    const hits = fts.search('cooking', 10);
    expect(hits.map((h) => h.id)).toEqual(['d3']);
    expect(hits[0]?.collection).toBe('kb');
    expect(hits[0]?.score).toBeGreaterThan(0); // higher = more relevant
  });

  it('enforces AND semantics — a doc must contain every query term (qmd parity)', () => {
    // d3 has "cooking" but not "security"; d1/d2 have "security" but not "cooking" → none match both.
    expect(fts.search('security cooking', 10)).toEqual([]);
  });

  it('ranks higher term frequency first at equal doc length (d2 repeats "audit")', () => {
    const hits = fts.search('security audit', 10);
    expect(hits.map((h) => h.id)).toEqual(['d2', 'd1']);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]!.score);
  });

  it('respects the k cutoff', () => {
    expect(fts.search('security', 1)).toHaveLength(1);
    expect(fts.search('security', 10)).toHaveLength(2);
  });

  it('returns [] for a query with no usable tokens', () => {
    expect(fts.search('!!! ---', 10)).toEqual([]);
  });

  it('does not throw on an operator-laden query', () => {
    expect(() => fts.search('security AND OR NOT *', 10)).not.toThrow();
  });

  it('upserts by id — re-indexing a doc replaces its content', () => {
    expect(fts.search('cooking', 10).map((h) => h.id)).toEqual(['d3']);
    fts.index([{ id: 'd3', collection: 'kb', content: 'security incident response' }]);
    expect(fts.count()).toBe(3); // not 4
    expect(fts.search('cooking', 10)).toEqual([]); // old content gone
    expect(fts.search('incident', 10).map((h) => h.id)).toEqual(['d3']); // new content searchable
  });

  it('clear() empties the index', () => {
    fts.clear();
    expect(fts.count()).toBe(0);
    expect(fts.search('security', 10)).toEqual([]);
  });
});

describe('fts5RetrievalFn + eval harness integration', () => {
  it('runs through runEval and scores recall on the gold docs', async () => {
    const fts = new Fts5Backend();
    fts.index([
      {
        id: 'qmd://kb/audit.md',
        content: 'the audit trail is a hash chain proving the record was not altered',
      },
      { id: 'qmd://kb/lifecycle.md', content: 'retire or deprecate a memory when it is outdated' },
      { id: 'qmd://kb/noise.md', content: 'unrelated content about gardening' },
    ]);

    const dataset: EvalDataset = {
      name: 'fts5-integration',
      idSpace: 'qmd:// citation',
      queries: [
        {
          id: 'q1',
          kind: 'lexical',
          query: 'audit trail hash chain',
          relevant: ['qmd://kb/audit.md'],
        },
        {
          id: 'q2',
          kind: 'lexical',
          query: 'deprecate memory outdated',
          relevant: ['qmd://kb/lifecycle.md'],
        },
      ],
    };

    const report = await runEval(dataset, fts5RetrievalFn(fts), { k: 10, backend: 'fts5' });
    fts.close();

    expect(report.backend).toBe('fts5');
    expect(report.queryCount).toBe(2);
    expect(report.meanRecallAtK).toBe(1); // both gold docs retrieved by keyword
    expect(report.meanNdcgAtK).toBe(1); // and each at rank 1
  });
});
