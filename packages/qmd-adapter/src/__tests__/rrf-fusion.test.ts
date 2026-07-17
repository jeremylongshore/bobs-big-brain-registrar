import { describe, expect, it } from 'vitest';
import { fuseReciprocalRank, RRF_K } from '../search/rrf-fusion.js';
import type { QmdSearchResult } from '../types.js';
import type { Fts5SearchHit } from '../native/fts5-backend.js';

function qmdHit(file: string, score: number, snippet = 'qmd-snip'): QmdSearchResult {
  return { file, score, snippet, collection: 'kb-curated' };
}

function nativeHit(id: string, score: number, snippet = 'fts-snip'): Fts5SearchHit {
  return { id, score, snippet, collection: 'kb-curated' };
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
});
