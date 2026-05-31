import { describe, it, expect } from 'vitest';
import { parseQueryOutput, deriveCollectionFromPath } from '../search/result-parser.js';

describe('parseQueryOutput', () => {
  it('parses qmd --json output', () => {
    const output = JSON.stringify([
      {
        docid: '#ba1275',
        score: 0.95,
        file: 'qmd://kb-curated/doc.md',
        title: 'Doc',
        snippet: 'Some relevant snippet',
      },
    ]);
    const results = parseQueryOutput(output);
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBe(0.95);
    expect(results[0]!.file).toBe('qmd://kb-curated/doc.md');
    expect(results[0]!.snippet).toBe('Some relevant snippet');
    expect(results[0]!.collection).toBe('kb-curated');
  });

  it('parses multiple hits', () => {
    const output = JSON.stringify([
      { score: 0.9, file: 'qmd://kb-curated/a.md', snippet: 'A' },
      { score: 0.8, file: 'qmd://kb-guides/b.md', snippet: 'B' },
      { score: 0.7, file: 'qmd://kb-inbox/c.md', snippet: 'C' },
    ]);
    const results = parseQueryOutput(output);
    expect(results).toHaveLength(3);
  });

  it('handles empty / non-JSON / non-array output without throwing', () => {
    expect(parseQueryOutput('')).toHaveLength(0);
    expect(parseQueryOutput('\n')).toHaveLength(0);
    expect(parseQueryOutput('not json at all')).toHaveLength(0);
    expect(parseQueryOutput('{"file":"x"}')).toHaveLength(0); // object, not array
    expect(parseQueryOutput('[]')).toHaveLength(0);
  });

  it('defaults missing / non-numeric scores to 0 and skips hits with no file', () => {
    const output = JSON.stringify([
      { file: 'qmd://kb-curated/doc.md', snippet: 'Snippet' }, // no score
      { score: 0.5, snippet: 'orphan' }, // no file → skipped
    ]);
    const results = parseQueryOutput(output);
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBe(0);
    expect(results[0]!.file).toBe('qmd://kb-curated/doc.md');
  });
});

describe('deriveCollectionFromPath', () => {
  it('derives kb-curated', () => {
    expect(deriveCollectionFromPath('qmd://kb-curated/doc.md')).toBe('kb-curated');
  });

  it('derives kb-inbox', () => {
    expect(deriveCollectionFromPath('/data/kb-inbox/doc.md')).toBe('kb-inbox');
  });

  it('returns unknown for unrecognized paths', () => {
    expect(deriveCollectionFromPath('/data/random/doc.md')).toBe('unknown');
  });
});
