import { describe, it, expect } from 'vitest';
import {
  computeFreshnessScore,
  CATEGORY_BOOST,
  rerankSearchHits,
  extractMemoryIdFromCitation,
  rerankCitedHits,
} from '../freshness.js';

const NOW = '2026-03-19T00:00:00.000Z';

/** Shift NOW by a given number of days into the past */
function daysAgo(days: number): string {
  const ms = new Date(NOW).getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

describe('computeFreshnessScore', () => {
  it('returns 1.0 for same-day content (age = 0)', () => {
    const score = computeFreshnessScore(NOW, NOW);
    expect(score).toBe(1.0);
  });

  it('returns ~0.5 at the default 90-day half-life', () => {
    const score = computeFreshnessScore(daysAgo(90), NOW);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('returns close to 0 for content older than 365 days', () => {
    const score = computeFreshnessScore(daysAgo(365), NOW);
    // e^(-ln2/90 * 365) ≈ 0.059
    expect(score).toBeLessThan(0.07);
    expect(score).toBeGreaterThan(0);
  });

  it('honours a custom half-life (30 days)', () => {
    const score = computeFreshnessScore(daysAgo(30), NOW, 30);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('clamps to 1.0 when updatedAt is in the future', () => {
    const future = new Date(new Date(NOW).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const score = computeFreshnessScore(future, NOW);
    expect(score).toBe(1.0);
  });

  it('decreases monotonically as age increases', () => {
    const ages = [0, 30, 90, 180, 365];
    const scores = ages.map((d) => computeFreshnessScore(daysAgo(d), NOW));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]!);
    }
  });
});

describe('CATEGORY_BOOST', () => {
  it('contains all expected category keys', () => {
    const expectedKeys = [
      'decision',
      'architecture',
      'convention',
      'pattern',
      'troubleshooting',
      'onboarding',
      'reference',
    ];
    for (const key of expectedKeys) {
      expect(CATEGORY_BOOST).toHaveProperty(key);
    }
  });

  it('gives decision the highest boost at 1.2', () => {
    const maxBoost = Math.max(...Object.values(CATEGORY_BOOST));
    expect(CATEGORY_BOOST['decision']).toBe(1.2);
    expect(CATEGORY_BOOST['decision']).toBe(maxBoost);
  });
});

describe('rerankSearchHits', () => {
  it('sorts hits by finalScore descending', () => {
    const hits = [
      { score: 1.0, category: 'reference', updatedAt: daysAgo(180) },
      { score: 1.0, category: 'decision', updatedAt: daysAgo(10) },
      { score: 1.0, category: 'convention', updatedAt: daysAgo(60) },
    ];
    const result = rerankSearchHits(hits, NOW);
    expect(result[0]!.finalScore).toBeGreaterThanOrEqual(result[1]!.finalScore);
    expect(result[1]!.finalScore).toBeGreaterThanOrEqual(result[2]!.finalScore);
  });

  it('ranks newest content first when all raw scores and categories are equal', () => {
    const hits = [
      { score: 1.0, category: 'troubleshooting', updatedAt: daysAgo(90) },
      { score: 1.0, category: 'troubleshooting', updatedAt: daysAgo(10) },
      { score: 1.0, category: 'troubleshooting', updatedAt: daysAgo(180) },
    ];
    const result = rerankSearchHits(hits, NOW);
    // Newest (10 days) should rank first, oldest (180 days) should rank last
    expect(result[0]!.updatedAt).toBe(daysAgo(10));
    expect(result[2]!.updatedAt).toBe(daysAgo(180));
  });

  it('applies a 1.0 boost for unknown categories', () => {
    const hits = [
      { score: 1.0, category: 'unknown-category', updatedAt: NOW },
      { score: 1.0, category: 'troubleshooting', updatedAt: NOW },
    ];
    const result = rerankSearchHits(hits, NOW);
    // troubleshooting boost is 1.0, unknown is also 1.0 — both equal
    expect(result[0]!.finalScore).toBe(result[1]!.finalScore);
  });

  it('returns an empty array when given an empty input', () => {
    const result = rerankSearchHits([], NOW);
    expect(result).toEqual([]);
  });
});

// ─── R1: cited-hit rerank (retrieval epic qmd-team-intent-kb-vps.1) ──────────

describe('extractMemoryIdFromCitation', () => {
  it('extracts the id from a qmd:// URI with a collection path', () => {
    expect(
      extractMemoryIdFromCitation('qmd://kb-curated/6f1a2b3c-4d5e-6789-abcd-ef0123456789.md'),
    ).toBe('6f1a2b3c-4d5e-6789-abcd-ef0123456789');
  });

  it('extracts the id from a nested exported path', () => {
    expect(extractMemoryIdFromCitation('decisions/abc-123.md')).toBe('abc-123');
  });

  it('handles a bare filename with no directory', () => {
    expect(extractMemoryIdFromCitation('abc-123.md')).toBe('abc-123');
  });

  it('only strips the final extension, preserving dots in the id', () => {
    expect(extractMemoryIdFromCitation('qmd://kb-guides/CLAUDE.md.md')).toBe('CLAUDE.md');
  });

  it('returns null for an empty basename', () => {
    expect(extractMemoryIdFromCitation('qmd://kb-curated/')).toBeNull();
    expect(extractMemoryIdFromCitation('')).toBeNull();
  });
});

describe('rerankCitedHits', () => {
  const NOW = '2026-07-17T12:00:00.000Z';
  const STALE = '2025-07-17T12:00:00.000Z'; // one year old ≈ 4 half-lives

  it('reorders a fresh decision above a stale reference with equal raw scores', () => {
    const hits = [
      { file: 'qmd://kb-guides/stale-ref.md', score: 1 },
      { file: 'qmd://kb-decisions/fresh-dec.md', score: 1 },
    ];
    const meta: Record<string, { category: string; updatedAt: string }> = {
      'stale-ref': { category: 'reference', updatedAt: STALE },
      'fresh-dec': { category: 'decision', updatedAt: NOW },
    };
    const reranked = rerankCitedHits(hits, (id) => meta[id] ?? null, NOW);
    expect(reranked[0]!.file).toBe('qmd://kb-decisions/fresh-dec.md');
    expect(reranked[0]!.finalScore).toBeGreaterThan(reranked[1]!.finalScore);
    expect(reranked[0]!.memoryId).toBe('fresh-dec');
  });

  it('leaves an unresolved citation unboosted and unpenalized', () => {
    const hits = [{ file: 'qmd://kb-curated/gone.md', score: 0.8 }];
    const reranked = rerankCitedHits(hits, () => null, NOW);
    expect(reranked[0]!.finalScore).toBe(0.8);
    expect(reranked[0]!.memoryId).toBeNull();
    expect(reranked[0]!.category).toBe('');
  });

  it('preserves qmd order between hits with identical metadata and scores', () => {
    const hits = [
      { file: 'qmd://kb-curated/a.md', score: 0.5 },
      { file: 'qmd://kb-curated/b.md', score: 0.5 },
    ];
    const reranked = rerankCitedHits(hits, () => null, NOW);
    expect(reranked.map((h) => h.file)).toEqual(hits.map((h) => h.file));
  });
});
