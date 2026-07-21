import { describe, expect, it } from 'vitest';
import { fuseReciprocalRank, RRF_K } from '../search/rrf-fusion.js';
import type { QmdSearchResult } from '../types.js';
import type { Fts5SearchHit } from '../native/fts5-backend.js';
import type { DenseSearchHit } from '../dense/dense-index.js';
import { denseScore } from '../dense/embed-client.js';

function qmdHit(file: string, score: number, snippet = 'qmd-snip'): QmdSearchResult {
  return { file, score, snippet, collection: 'kb-curated' };
}

function nativeHit(id: string, score: number, snippet = 'fts-snip'): Fts5SearchHit {
  return { id, score, snippet, collection: 'kb-curated' };
}

function denseHit(id: string, score: number, snippet = 'dense-snip'): DenseSearchHit {
  return { id, score: denseScore(score), snippet, collection: 'kb-curated' };
}

describe('fuseReciprocalRank', () => {
  it('ranks a document present in both lists above single-list documents at the same ranks', () => {
    const fused = fuseReciprocalRank(
      [qmdHit('qmd://kb-curated/both.md', 3), qmdHit('qmd://kb-curated/qmd-only.md', 2)],
      [nativeHit('qmd://kb-curated/both.md', 9), nativeHit('qmd://kb-curated/fts-only.md', 8)],
    );
    expect(fused[0]!.file).toBe('qmd://kb-curated/both.md');
    // rank 1 in both lists: 2/(k+1) vs rank-2 singles at 1/(k+2)
    expect(fused[0]!.score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it('computes the standard RRF sum over 1-based ranks', () => {
    const fused = fuseReciprocalRank(
      [qmdHit('qmd://kb-curated/a.md', 5), qmdHit('qmd://kb-curated/b.md', 4)],
      [nativeHit('qmd://kb-curated/b.md', 7)],
    );
    const b = fused.find((h) => h.file.endsWith('/b.md'))!;
    expect(b.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 10);
    const a = fused.find((h) => h.file.endsWith('/a.md'))!;
    expect(a.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it('surfaces a native-only hit qmd missed entirely (the hyphen miss class)', () => {
    const fused = fuseReciprocalRank([], [nativeHit('qmd://kb-curated/governed-brain-fix.md', 4)]);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.file).toBe('qmd://kb-curated/governed-brain-fix.md');
    expect(fused[0]!.snippet).toBe('fts-snip');
  });

  it('prefers the qmd snippet when a document appears in both lists', () => {
    const fused = fuseReciprocalRank(
      [qmdHit('qmd://kb-curated/x.md', 1, 'rich qmd context')],
      [nativeHit('qmd://kb-curated/x.md', 1, 'fts ellipsis')],
    );
    expect(fused[0]!.snippet).toBe('rich qmd context');
  });

  it('breaks score ties deterministically: best single-list rank, then id order', () => {
    // Two docs each appearing only at rank 1 of one list — identical RRF score.
    const fused = fuseReciprocalRank(
      [qmdHit('qmd://kb-curated/zeta.md', 1)],
      [nativeHit('qmd://kb-curated/alpha.md', 1)],
    );
    expect(fused[0]!.score).toBe(fused[1]!.score);
    expect(fused.map((h) => h.file)).toEqual([
      'qmd://kb-curated/alpha.md',
      'qmd://kb-curated/zeta.md',
    ]);
    // Deterministic: same input, same output, every time.
    const again = fuseReciprocalRank(
      [qmdHit('qmd://kb-curated/zeta.md', 1)],
      [nativeHit('qmd://kb-curated/alpha.md', 1)],
    );
    expect(again.map((h) => h.file)).toEqual(fused.map((h) => h.file));
  });

  it('returns [] when both lists are empty', () => {
    expect(fuseReciprocalRank([], [])).toEqual([]);
  });

  // ---- dense third list (B4) ---------------------------------------------

  it('an omitted dense list is byte-identical to the two-list fusion (the default path)', () => {
    const qmd = [qmdHit('qmd://kb-curated/a.md', 5), qmdHit('qmd://kb-curated/b.md', 4)];
    const native = [nativeHit('qmd://kb-curated/b.md', 7)];
    expect(fuseReciprocalRank(qmd, native)).toEqual(fuseReciprocalRank(qmd, native, []));
  });

  it('surfaces a dense-only hit both lexical backends missed (the paraphrase miss class)', () => {
    const fused = fuseReciprocalRank(
      [qmdHit('qmd://kb-curated/lex.md', 5)],
      [],
      [denseHit('qmd://kb-curated/paraphrase-only.md', 0.91)],
    );
    expect(fused.map((h) => h.file)).toContain('qmd://kb-curated/paraphrase-only.md');
    const denseOnly = fused.find((h) => h.file.endsWith('/paraphrase-only.md'))!;
    expect(denseOnly.snippet).toBe('dense-snip'); // dense stored lead text fills in
    expect(denseOnly.collection).toBe('kb-curated');
  });

  it('a document present in all three lists outranks two-list documents at the same ranks', () => {
    const fused = fuseReciprocalRank(
      [qmdHit('qmd://kb-curated/all3.md', 3), qmdHit('qmd://kb-curated/two.md', 2)],
      [nativeHit('qmd://kb-curated/all3.md', 9), nativeHit('qmd://kb-curated/two.md', 8)],
      [denseHit('qmd://kb-curated/all3.md', 0.9)],
    );
    expect(fused[0]!.file).toBe('qmd://kb-curated/all3.md');
    expect(fused[0]!.score).toBeCloseTo(3 / (RRF_K + 1), 10);
    expect(fused[1]!.score).toBeCloseTo(2 / (RRF_K + 2), 10);
  });

  it('the fused score is pure rank arithmetic — the dense model score magnitude never leaks in', () => {
    // Two runs whose dense scores differ wildly but whose RANKS are identical
    // must produce identical fused scores: fusion consumes ranks only.
    const run = (a: number, b: number) =>
      fuseReciprocalRank(
        [],
        [],
        [denseHit('qmd://kb-curated/x.md', a), denseHit('qmd://kb-curated/y.md', b)],
      );
    expect(run(0.99, 0.98)).toEqual(run(0.51, 0.02));
    expect(run(0.99, 0.98)[0]!.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it('snippet preference is qmd → native → dense', () => {
    const fused = fuseReciprocalRank(
      [qmdHit('qmd://kb-curated/a.md', 5, 'from-qmd')],
      [
        nativeHit('qmd://kb-curated/a.md', 4, 'from-fts'),
        nativeHit('qmd://kb-curated/b.md', 3, 'from-fts'),
      ],
      [
        denseHit('qmd://kb-curated/a.md', 0.9),
        denseHit('qmd://kb-curated/b.md', 0.8),
        denseHit('qmd://kb-curated/c.md', 0.7),
      ],
    );
    const byId = new Map(fused.map((h) => [h.file, h.snippet]));
    expect(byId.get('qmd://kb-curated/a.md')).toBe('from-qmd');
    expect(byId.get('qmd://kb-curated/b.md')).toBe('from-fts');
    expect(byId.get('qmd://kb-curated/c.md')).toBe('dense-snip');
  });
});
