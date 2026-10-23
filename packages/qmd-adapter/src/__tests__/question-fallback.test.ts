import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Fts5Backend } from '../native/fts5-backend.js';

describe('bounded natural-question lexical fallback', () => {
  let backend: Fts5Backend;
  beforeEach(() => {
    backend = new Fts5Backend();
    backend.index([
      {
        id: 'token-guide',
        collection: 'kb-curated',
        content: 'Access tokens remain in the credential vault.',
      },
      { id: 'token-noise', collection: 'kb-curated', content: 'tokens for a cooking game' },
      { id: 'archive', collection: 'kb-archive', content: 'where are access tokens stored' },
      { id: 'alerts', collection: 'kb-curated', content: 'email onboarding alerts' },
      { id: 'partial-alerts', collection: 'kb-curated', content: 'configure email' },
      { id: 'unicode', collection: 'kb-curated', content: 'cafe deployment handbook' },
    ]);
  });
  afterEach(() => backend.close());

  it('finds two content terms without requiring question function words or every inflection', () => {
    expect(backend.search('where are access tokens stored', 10, ['kb-curated'])).toEqual([]);
    expect(
      backend
        .searchQuestionFallback('where are access tokens stored', 10, ['kb-curated'])
        .map((h) => h.id),
    ).toEqual(['token-guide']);
  });

  it('requires enough distinct topical terms to exclude weak partial matches', () => {
    expect(
      backend
        .searchQuestionFallback('how do we configure email onboarding alerts', 10, ['kb-curated'])
        .map((h) => h.id),
    ).toEqual(['alerts']);
  });

  it('uses the index token semantics for accented terms', () => {
    expect(
      backend
        .searchQuestionFallback('where are café deployment settings', 10, ['kb-curated'])
        .map((h) => h.id),
    ).toEqual(['unicode']);
  });

  it('keeps keyword and explicitly quoted searches out of the fallback', () => {
    expect(backend.searchQuestionFallback('access absent', 10, ['kb-curated'])).toEqual([]);
    expect(
      backend.searchQuestionFallback('"where are access tokens stored"', 10, ['kb-curated']),
    ).toEqual([]);
    expect(
      backend.searchQuestionFallback('where are "access tokens" stored', 10, ['kb-curated']),
    ).toEqual([]);
    expect(backend.searchQuestionFallback('what is it', 10, ['kb-curated'])).toEqual([]);
  });

  it('cannot turn user punctuation into wildcard or boolean execution', () => {
    expect(
      backend
        .searchQuestionFallback('where are access tokens stored? *', 10, ['kb-curated'])
        .map((h) => h.id),
    ).toEqual(['token-guide']);
    expect(
      backend.searchQuestionFallback('where are access tokens stored OR unrelated', 10, [
        'kb-curated',
      ]),
    ).toEqual([]);
  });

  it('bounds content terms and applies collection scope before candidate limits', () => {
    const oversized = 'where ' + Array.from({ length: 13 }, (_, i) => `term${i}`).join(' ');
    expect(backend.searchQuestionFallback(oversized, 10, ['kb-curated'])).toEqual([]);
    backend.index(
      Array.from({ length: 70 }, (_, i) => ({
        id: `archive-${i}`,
        collection: 'kb-archive',
        content: 'access tokens stored',
      })),
    );
    expect(
      backend
        .searchQuestionFallback('where are access tokens stored', 1, ['kb-curated'])
        .map((h) => h.id),
    ).toEqual(['token-guide']);
  });

  it('rejects oversized queries and invalid cutoffs while preserving one-topic questions', () => {
    expect(backend.searchQuestionFallback('where are tokens', 1, ['kb-curated'])).toHaveLength(1);
    expect(
      backend.searchQuestionFallback('where ' + 'tokens '.repeat(600), 10, ['kb-curated']),
    ).toEqual([]);
    for (const k of [0, -1, 1.5, Infinity]) {
      expect(
        backend.searchQuestionFallback('where are access tokens stored', k, ['kb-curated']),
      ).toEqual([]);
    }
  });

  it('evaluates coverage before the cutoff even with more than200 weak high-BM25 matches', () => {
    backend.clear();
    backend.index([
      ...['access', 'tokens', 'stored'].flatMap((term) =>
        Array.from({ length: 250 }, (_, i) => ({
          id: `${term}-${i}`,
          collection: 'kb-curated',
          content: term,
        })),
      ),
      {
        id: 'complete',
        collection: 'kb-curated',
        content: 'access tokens stored ' + 'padding '.repeat(10000),
      },
    ]);
    expect(
      backend
        .searchQuestionFallback('where are access tokens stored', 1, ['kb-curated'])
        .map((h) => h.id),
    ).toEqual(['complete']);
  });

  it('prioritizes actual term coverage before BM25 and retains the requested cutoff', () => {
    backend.index([
      {
        id: 'complete',
        collection: 'kb-curated',
        content: 'access tokens stored ' + 'padding '.repeat(1000),
      },
      { id: 'frequent', collection: 'kb-curated', content: 'access tokens '.repeat(20) },
    ]);
    expect(
      backend
        .searchQuestionFallback('where are access tokens stored', 1, ['kb-curated'])
        .map((h) => h.id),
    ).toEqual(['complete']);
  });
});
