import { describe, it, expect } from 'vitest';
import { evaluateRelevanceScore } from '../rules/relevance-score-rule.js';
import { makeCandidate, makeContext } from './fixtures.js';

function makeRule(parameters: Record<string, unknown> = {}) {
  return {
    id: 'rule-relevance-score',
    type: 'relevance_score' as const,
    action: 'flag' as const,
    enabled: true,
    priority: 0,
    parameters,
  };
}

describe('evaluateRelevanceScore', () => {
  it('scores 1.0 for a fully decorated candidate', () => {
    // All 10 signals active: title(0.20) + content>200(0.20) + category(0.05) + filePaths(0.10)
    //   + projectContext(0.10) + tags(0.10) + highTrust(0.05)
    //   + uniqueWords>15(0.10) + manual(0.10) = 1.0
    const richContent =
      'Use Result<T, E> for all fallible operations across the entire codebase. ' +
      'This convention ensures consistent error propagation and eliminates unchecked exceptions. ' +
      'Apply it to async functions, repository methods, and service boundaries alike.';
    const candidate = makeCandidate({
      title: 'Full metadata candidate',
      content: richContent, // > 200 chars, > 15 unique words
      source: 'manual',
      category: 'convention',
      trustLevel: 'high',
      metadata: {
        filePaths: ['src/utils.ts'],
        projectContext: 'main-api',
        tags: ['typescript'],
      },
    });
    const rule = makeRule({ minimumScore: 0.0 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('pass');
    expect(result.score).toBeCloseTo(1.0, 5);
  });

  it('scores low for bare minimum candidate', () => {
    // Minimal: short content (<=50 chars), no filePaths, no tags, no projectContext,
    // not high trust, source=claude_session — only title(0.20) + category(0.05) = 0.25
    const candidate = makeCandidate({
      title: 'minimal',
      content: 'Short content here.', // 19 chars, <=50
      category: 'reference',
      trustLevel: 'low',
      metadata: { filePaths: [], tags: [] },
    });
    const rule = makeRule({ minimumScore: 0.0 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    // title=0.20, category=0.05 → 0.25
    expect(result.score).toBeCloseTo(0.25, 5);
  });

  it('title adds 0.20 to score', () => {
    // Only contributing factors: title and category
    const candidateWithTitle = makeCandidate({
      title: 'My title',
      content: 'Short.', // <=50 chars
      category: 'reference',
      trustLevel: 'low',
      metadata: { filePaths: [], tags: [] },
    });
    const rule = makeRule({ minimumScore: 0.0 });
    const result = evaluateRelevanceScore(
      candidateWithTitle,
      rule,
      makeContext(candidateWithTitle),
    );
    // title=0.20, category=0.05 → 0.25
    expect(result.score).toBeCloseTo(0.25, 5);
  });

  it('graduated content: 50-200 chars adds 0.10', () => {
    // 51 identical chars — qualifies for the lower content tier only
    const candidate = makeCandidate({
      title: 'T',
      content: 'x'.repeat(51), // 51 chars, in the 50-200 range; only 1 unique word
      category: 'reference',
      trustLevel: 'low',
      metadata: { filePaths: [], tags: [] },
    });
    const rule = makeRule({ minimumScore: 0.0 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    // title=0.20, content(50-200)=0.10, category=0.05 → 0.35
    expect(result.score).toBeCloseTo(0.35, 5);
  });

  it('graduated content: > 200 chars adds 0.20', () => {
    // 250 identical chars — qualifies for the upper content tier
    const candidate = makeCandidate({
      title: 'T',
      content: 'x'.repeat(250), // 250 chars, > 200; only 1 unique word
      category: 'reference',
      trustLevel: 'low',
      metadata: { filePaths: [], tags: [] },
    });
    const rule = makeRule({ minimumScore: 0.0 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    // title=0.20, content>200=0.20, category=0.05 → 0.45
    expect(result.score).toBeCloseTo(0.45, 5);
  });

  it('filePaths add 0.10 to score', () => {
    const candidate = makeCandidate({
      title: 'T',
      content: 'Short.', // <=50 chars
      category: 'reference',
      trustLevel: 'low',
      metadata: { filePaths: ['src/index.ts'], tags: [] },
    });
    const rule = makeRule({ minimumScore: 0.0 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    // title=0.20, category=0.05, filePaths=0.10 → 0.35
    expect(result.score).toBeCloseTo(0.35, 5);
  });

  it('tags add 0.10 to score', () => {
    const candidate = makeCandidate({
      title: 'T',
      content: 'Short.', // <=50 chars
      category: 'reference',
      trustLevel: 'low',
      metadata: { filePaths: [], tags: ['typescript'] },
    });
    const rule = makeRule({ minimumScore: 0.0 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    // title=0.20, category=0.05, tags=0.10 → 0.35
    expect(result.score).toBeCloseTo(0.35, 5);
  });

  it('high trust adds 0.05 to score', () => {
    const candidate = makeCandidate({
      title: 'T',
      content: 'Short.', // <=50 chars
      category: 'reference',
      trustLevel: 'high',
      metadata: { filePaths: [], tags: [] },
    });
    const rule = makeRule({ minimumScore: 0.0 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    // title=0.20, category=0.05, highTrust=0.05 → 0.30
    expect(result.score).toBeCloseTo(0.3, 5);
  });

  it('unique word count > 15 adds 0.10', () => {
    // 20 distinct words, all short — stays <=50 chars total to keep content tier out of play
    const twentyUniqueWords =
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi';
    const candidate = makeCandidate({
      title: 'T',
      content: twentyUniqueWords, // > 15 unique words; length is ~100 chars (50-200 tier)
      category: 'reference',
      trustLevel: 'low',
      metadata: { filePaths: [], tags: [] },
    });
    const rule = makeRule({ minimumScore: 0.0 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    // title=0.20, content(50-200)=0.10, category=0.05, uniqueWords=0.10 → 0.45
    expect(result.score).toBeCloseTo(0.45, 5);
  });

  it('source manual/import adds 0.10', () => {
    const candidate = makeCandidate({
      title: 'T',
      content: 'Short.', // <=50 chars
      source: 'manual',
      category: 'reference',
      trustLevel: 'low',
      metadata: { filePaths: [], tags: [] },
    });
    const rule = makeRule({ minimumScore: 0.0 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    // title=0.20, category=0.05, source=manual=0.10 → 0.35
    expect(result.score).toBeCloseTo(0.35, 5);
  });

  it('flags when score is below minimumScore threshold', () => {
    // Score will be 0.25 (title + category only), minimum is 0.8
    const candidate = makeCandidate({
      title: 'minimal',
      content: 'Short.', // <=50 chars
      category: 'reference',
      trustLevel: 'low',
      metadata: { filePaths: [], tags: [] },
    });
    const rule = makeRule({ minimumScore: 0.8 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('flag');
    expect(result.reason).toContain('below minimum');
  });
});

describe('evaluateRelevanceScore — source-keyed hard reject (5kw.3)', () => {
  /** Junk-shaped overrides: title + category only → score 0.25 (+0.10 when
   *  source is manual/import). Below the 0.8 threshold used here either way. */
  const junk = {
    title: 'minimal',
    content: 'Short.', // <=50 chars
    category: 'reference',
    trustLevel: 'low',
    metadata: { filePaths: [], tags: [] },
  } as const;

  it("returns 'fail' (rejectable) for a below-threshold import-source candidate by default", () => {
    const candidate = makeCandidate({ ...junk, source: 'import' });
    const rule = makeRule({ minimumScore: 0.8 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain("import-class source 'import'");
  });

  it("returns 'fail' for a below-threshold bulk_import candidate by default", () => {
    const candidate = makeCandidate({ ...junk, source: 'bulk_import' });
    const rule = makeRule({ minimumScore: 0.8 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
  });

  it('still only flags an identical below-threshold candidate from an interactive source', () => {
    for (const source of ['mcp', 'claude_session', 'manual'] as const) {
      const candidate = makeCandidate({ ...junk, source });
      const rule = makeRule({ minimumScore: 0.8 });
      const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
      expect(result.outcome).toBe('flag');
    }
  });

  it('an empty rejectSources parameter restores flag-only behavior for imports', () => {
    const candidate = makeCandidate({ ...junk, source: 'import' });
    const rule = makeRule({ minimumScore: 0.8, rejectSources: [] });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('flag');
  });

  it('ignores rejectSources entries that are not valid MemorySource values', () => {
    const candidate = makeCandidate({ ...junk, source: 'import' });
    // A typo can only make the rule SOFTER: 'improt' is dropped, so nothing fails…
    const softened = evaluateRelevanceScore(
      candidate,
      makeRule({ minimumScore: 0.8, rejectSources: ['improt'] }),
      makeContext(candidate),
    );
    expect(softened.outcome).toBe('flag');
    // …while valid entries alongside garbage still apply.
    const mixed = evaluateRelevanceScore(
      candidate,
      makeRule({ minimumScore: 0.8, rejectSources: ['improt', 'import'] }),
      makeContext(candidate),
    );
    expect(mixed.outcome).toBe('fail');
  });

  it('an above-threshold import candidate passes untouched', () => {
    const candidate = makeCandidate({ ...junk, source: 'import' });
    // import source: title 0.20 + category 0.05 + source 0.10 = 0.35 ≥ 0.3
    const rule = makeRule({ minimumScore: 0.3 });
    const result = evaluateRelevanceScore(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('pass');
  });
});
