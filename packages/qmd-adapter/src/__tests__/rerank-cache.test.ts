import { describe, expect, it } from 'vitest';

import { RerankCache } from '../rerank/rerank-cache.js';
import { rerankScore } from '../rerank/rerank-client.js';

describe('RerankCache (B1) — content-addressed sidecar score cache', () => {
  it('round-trips a score keyed on (query, doc content hash)', () => {
    const cache = new RerankCache({ path: ':memory:', modelId: 'm.gguf', modelVersion: 'aaa' });
    expect(cache.get('q', 'dochash1')).toBeNull();
    cache.set('q', 'dochash1', rerankScore(0.87));
    expect(cache.get('q', 'dochash1')).toBeCloseTo(0.87);
    expect(cache.count()).toBe(1);
    cache.close();
  });

  it('misses when the query differs, the doc differs, or the model differs', () => {
    const cacheA = new RerankCache({ path: ':memory:', modelId: 'm.gguf', modelVersion: 'aaa' });
    cacheA.set('q', 'dochash1', rerankScore(0.5));
    expect(cacheA.get('other query', 'dochash1')).toBeNull();
    expect(cacheA.get('q', 'dochash2')).toBeNull();
    cacheA.close();

    // Same key, different model version (a weights bump) — separate namespace.
    const cacheB = new RerankCache({ path: ':memory:', modelId: 'm.gguf', modelVersion: 'bbb' });
    expect(cacheB.get('q', 'dochash1')).toBeNull();
    cacheB.close();
  });

  it('the key separator prevents query/hash boundary ambiguity', () => {
    // ('ab', 'c') and ('a', 'bc') must not collide.
    expect(RerankCache.cacheKey('ab', 'c')).not.toBe(RerankCache.cacheKey('a', 'bc'));
  });

  it('an upsert overwrites the prior score for the same key + model', () => {
    const cache = new RerankCache({ path: ':memory:', modelId: 'm.gguf', modelVersion: 'aaa' });
    cache.set('q', 'dochash1', rerankScore(0.1));
    cache.set('q', 'dochash1', rerankScore(0.9));
    expect(cache.get('q', 'dochash1')).toBeCloseTo(0.9);
    expect(cache.count()).toBe(1);
    cache.close();
  });

  it('degrades silently (get null / set no-op) after the db is closed underneath it', () => {
    const cache = new RerankCache({ path: ':memory:', modelId: 'm.gguf', modelVersion: 'aaa' });
    cache.set('q', 'dochash1', rerankScore(0.5));
    cache.close();
    // A broken cache must degrade to uncached behaviour, never throw.
    expect(cache.get('q', 'dochash1')).toBeNull();
    expect(() => cache.set('q', 'dochash2', rerankScore(0.4))).not.toThrow();
  });
});
