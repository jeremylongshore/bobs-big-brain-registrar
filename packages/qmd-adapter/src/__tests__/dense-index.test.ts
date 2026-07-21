import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DenseVecIndex } from '../dense/dense-index.js';

/** Unit vector helper (3 dims is plenty — dims are discovered, not hardcoded). */
function vec(x: number, y: number, z: number): Float32Array {
  const v = new Float32Array([x, y, z]);
  const norm = Math.hypot(x, y, z);
  return norm === 0 ? v : v.map((c) => c / norm);
}

const MODEL = { modelId: 'test-model.gguf', modelVersion: 'abc123' };

function openIndex(overrides: Partial<typeof MODEL> = {}): DenseVecIndex {
  return new DenseVecIndex({ path: ':memory:', ...MODEL, ...overrides });
}

describe('DenseVecIndex (B4) — sqlite-vec sidecar', () => {
  it('stores docs and ranks KNN hits by similarity to the query vector', () => {
    const index = openIndex();
    index.upsert({
      docId: 'qmd://kb-curated/x.md',
      collection: 'kb-curated',
      contentHash: 'h1',
      snippet: 'x snippet',
      embedding: vec(1, 0, 0),
    });
    index.upsert({
      docId: 'qmd://kb-guides/y.md',
      collection: 'kb-guides',
      contentHash: 'h2',
      snippet: 'y snippet',
      embedding: vec(0, 1, 0),
    });

    const hits = index.search(vec(0.95, 0.05, 0), 2);
    expect(hits.map((h) => h.id)).toEqual(['qmd://kb-curated/x.md', 'qmd://kb-guides/y.md']);
    expect(hits[0]?.collection).toBe('kb-curated');
    expect(hits[0]?.snippet).toBe('x snippet');
    // Cosine similarity: near-parallel ≈ 1, orthogonal ≈ 0.
    expect(hits[0]?.score as number).toBeGreaterThan(0.9);
    expect(hits[1]?.score as number).toBeLessThan(0.2);
    expect(index.count()).toBe(2);
  });

  it('upsert by docId replaces the prior vector instead of duplicating', () => {
    const index = openIndex();
    const doc = {
      docId: 'qmd://kb-curated/x.md',
      collection: 'kb-curated',
      contentHash: 'h1',
      snippet: 's',
    };
    index.upsert({ ...doc, embedding: vec(1, 0, 0) });
    index.upsert({ ...doc, contentHash: 'h2', embedding: vec(0, 0, 1) });

    expect(index.count()).toBe(1);
    const hits = index.search(vec(0, 0, 1), 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.score as number).toBeGreaterThan(0.99); // the NEW vector answers
    expect(index.entries()).toEqual([{ docId: 'qmd://kb-curated/x.md', contentHash: 'h2' }]);
  });

  it('remove() drops doc + vector; unknown ids are a no-op', () => {
    const index = openIndex();
    index.upsert({
      docId: 'qmd://kb-curated/x.md',
      collection: 'kb-curated',
      contentHash: 'h1',
      snippet: 's',
      embedding: vec(1, 0, 0),
    });
    index.remove(['qmd://kb-curated/x.md', 'qmd://kb-curated/never-indexed.md']);
    expect(index.count()).toBe(0);
    expect(index.search(vec(1, 0, 0), 5)).toEqual([]);
  });

  it('search on an empty/unbuilt index returns [] (no vec table yet)', () => {
    const index = openIndex();
    expect(index.search(vec(1, 0, 0), 5)).toEqual([]);
  });

  it('scope-filters INSIDE the KNN via the partition key (archive never steals a slot)', () => {
    const index = openIndex();
    // A cluster of archive docs all NEARER the query than the one curated doc.
    for (let i = 0; i < 5; i++) {
      index.upsert({
        docId: `qmd://kb-archive/a${i}.md`,
        collection: 'kb-archive',
        contentHash: `arch${i}`,
        snippet: `archive ${i}`,
        embedding: vec(1, 0.001 * i, 0),
      });
    }
    index.upsert({
      docId: 'qmd://kb-curated/keep.md',
      collection: 'kb-curated',
      contentHash: 'keep',
      snippet: 'the curated answer',
      embedding: vec(0.9, 0.1, 0),
    });

    // k=3 with NO filter would be three archive docs — the curated doc loses.
    const unfiltered = index.search(vec(1, 0, 0), 3);
    expect(unfiltered.every((h) => h.collection === 'kb-archive')).toBe(true);

    // k=3 scoped to curated returns the curated doc DESPITE five nearer archive
    // docs — the filter is applied within the KNN, not after it.
    const scoped = index.search(vec(1, 0, 0), 3, ['kb-curated', 'kb-decisions', 'kb-guides']);
    expect(scoped.map((h) => h.id)).toEqual(['qmd://kb-curated/keep.md']);
  });

  it('a query vector of the wrong dimension returns [] instead of erroring', () => {
    const index = openIndex();
    index.upsert({
      docId: 'qmd://kb-curated/x.md',
      collection: 'kb-curated',
      contentHash: 'h1',
      snippet: 's',
      embedding: vec(1, 0, 0),
    });
    expect(index.search(new Float32Array([1, 0]), 5)).toEqual([]);
  });

  it('wipes all vectors when reopened under a different model version (pin gate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dense-index-test-'));
    const path = join(dir, 'dense-vec.sqlite');
    const first = new DenseVecIndex({ path, ...MODEL });
    first.upsert({
      docId: 'qmd://kb-curated/x.md',
      collection: 'kb-curated',
      contentHash: 'h1',
      snippet: 's',
      embedding: vec(1, 0, 0),
    });
    expect(first.count()).toBe(1);
    first.close();

    const samePin = new DenseVecIndex({ path, ...MODEL });
    expect(samePin.count()).toBe(1); // same weights → vectors survive
    samePin.close();

    const bumped = new DenseVecIndex({ path, ...MODEL, modelVersion: 'NEW-HASH' });
    expect(bumped.count()).toBe(0); // model bump → auto-invalidated
    bumped.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
