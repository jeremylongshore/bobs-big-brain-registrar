import { describe, it, expect } from 'vitest';
import type { PolicyRule, MemoryCategory } from '@qmd-team-intent-kb/schema';
import { evaluateContradictionCheck } from '../rules/contradiction-check-rule.js';
import type { ActiveMemorySnapshot, EvaluationContext } from '../types.js';
import { makeCandidate, makeContext } from './fixtures.js';

function makeRule(overrides?: Partial<PolicyRule>): PolicyRule {
  return {
    id: 'rule-contradiction_check',
    type: 'contradiction_check',
    action: 'flag',
    enabled: true,
    priority: 0,
    parameters: {},
    ...overrides,
  };
}

/**
 * Wrap makeContext with a category-scoped active-memory map so tests can
 * observe both the lookup wiring and the category scoping.
 */
function withActiveMemories(
  context: EvaluationContext,
  byCategory: Partial<Record<MemoryCategory, ActiveMemorySnapshot[]>>,
): EvaluationContext {
  return {
    ...context,
    getActiveMemoriesInCategory: (category) => byCategory[category] ?? [],
  };
}

const CONVENTION_TEXT =
  'Always wrap async boundaries in try/catch and convert failures to Result types for the caller.';
// Same topic, heavily overlapping vocabulary, different text — the v1 target shape.
const CONTRADICTING_TEXT =
  'Never wrap async boundaries in try/catch and convert failures to Result types for the caller.';
const DISJOINT_TEXT =
  'Deploy the ingest daemon with systemd timers; blue-green swaps happen at the Caddy layer.';

describe('evaluateContradictionCheck', () => {
  it('passes vacuously when no active-memory lookup is injected', () => {
    const candidate = makeCandidate({ content: CONVENTION_TEXT });
    const result = evaluateContradictionCheck(candidate, makeRule(), makeContext(candidate));
    expect(result.outcome).toBe('pass');
    expect(result.reason).toMatch(/skipped/i);
  });

  it('flags a candidate with high token overlap against an active same-category memory', () => {
    const candidate = makeCandidate({ content: CONVENTION_TEXT, category: 'convention' });
    const context = withActiveMemories(makeContext(candidate), {
      convention: [{ id: 'mem-1', content: CONTRADICTING_TEXT }],
    });
    const result = evaluateContradictionCheck(candidate, makeRule(), context);
    expect(result.outcome).toBe('flag');
    expect(result.reason).toContain('mem-1');
    expect(result.reason).toMatch(/human review/i);
    expect(result.score).toBeGreaterThanOrEqual(0.6);
  });

  it('stays silent on disjoint content in the same category', () => {
    const candidate = makeCandidate({ content: CONVENTION_TEXT, category: 'convention' });
    const context = withActiveMemories(makeContext(candidate), {
      convention: [{ id: 'mem-2', content: DISJOINT_TEXT }],
    });
    const result = evaluateContradictionCheck(candidate, makeRule(), context);
    expect(result.outcome).toBe('pass');
  });

  it('is category-scoped: an overlapping memory in ANOTHER category does not flag', () => {
    const candidate = makeCandidate({ content: CONVENTION_TEXT, category: 'convention' });
    const context = withActiveMemories(makeContext(candidate), {
      // The near-identical text lives under 'decision', not the candidate's category.
      decision: [{ id: 'mem-3', content: CONTRADICTING_TEXT }],
    });
    const result = evaluateContradictionCheck(candidate, makeRule(), context);
    expect(result.outcome).toBe('pass');
  });

  it('skips byte-identical content — exact duplication is dedup_check territory', () => {
    const candidate = makeCandidate({ content: CONVENTION_TEXT, category: 'convention' });
    const context = withActiveMemories(makeContext(candidate), {
      convention: [{ id: 'mem-4', content: CONVENTION_TEXT }],
    });
    const result = evaluateContradictionCheck(candidate, makeRule(), context);
    expect(result.outcome).toBe('pass');
  });

  it('never returns fail — the v1 contract is pass or flag only', () => {
    const candidate = makeCandidate({ content: CONVENTION_TEXT, category: 'convention' });
    const context = withActiveMemories(makeContext(candidate), {
      convention: [{ id: 'mem-5', content: CONTRADICTING_TEXT }],
    });
    // Even configured with action=reject, the evaluator's own outcome is 'flag'.
    const result = evaluateContradictionCheck(candidate, makeRule({ action: 'reject' }), context);
    expect(['pass', 'flag']).toContain(result.outcome);
    expect(result.outcome).not.toBe('fail');
  });

  it('respects a custom threshold parameter', () => {
    const candidate = makeCandidate({ content: CONVENTION_TEXT, category: 'convention' });
    const context = withActiveMemories(makeContext(candidate), {
      convention: [{ id: 'mem-6', content: CONTRADICTING_TEXT }],
    });
    // Threshold 1.0: nothing short of full token-set overlap flags.
    const strict = evaluateContradictionCheck(
      candidate,
      makeRule({ parameters: { threshold: 1.0 } }),
      context,
    );
    expect(strict.outcome).toBe('pass');
    // Threshold ~0: any overlap flags.
    const loose = evaluateContradictionCheck(
      candidate,
      makeRule({ parameters: { threshold: 0.01 } }),
      context,
    );
    expect(loose.outcome).toBe('flag');
  });

  it('names every suspect (capped) and reports the top similarity as score', () => {
    const candidate = makeCandidate({ content: CONVENTION_TEXT, category: 'convention' });
    const context = withActiveMemories(makeContext(candidate), {
      convention: [
        { id: 'mem-a', content: CONTRADICTING_TEXT },
        { id: 'mem-b', content: `${CONVENTION_TEXT} Additionally prefer neverthrow.` },
        { id: 'mem-c', content: DISJOINT_TEXT },
      ],
    });
    const result = evaluateContradictionCheck(candidate, makeRule(), context);
    expect(result.outcome).toBe('flag');
    expect(result.reason).toContain('mem-a');
    expect(result.reason).toContain('mem-b');
    expect(result.reason).not.toContain('mem-c');
    expect(result.score).toBeGreaterThan(0);
  });

  it('passes when the category has no active memories at all', () => {
    const candidate = makeCandidate({ content: CONVENTION_TEXT, category: 'convention' });
    const context = withActiveMemories(makeContext(candidate), {});
    const result = evaluateContradictionCheck(candidate, makeRule(), context);
    expect(result.outcome).toBe('pass');
  });

  // E1 review follow-up: the tokenizer is Unicode-aware. Under the old
  // ASCII-only [a-z0-9]+ pattern, both of these texts tokenized to the empty
  // set (Cyrillic has no ASCII letters), Jaccard returned 0 for BOTH empty
  // sets, and heavy non-Latin overlap was invisible.
  it('flags heavy overlap between non-Latin (Cyrillic) texts', () => {
    const original =
      'Всегда развертывайте сервисы через синие зеленые переключения на балансировщике нагрузки';
    const contradicting =
      'Никогда развертывайте сервисы через синие зеленые переключения на балансировщике нагрузки';
    const candidate = makeCandidate({ content: original, category: 'convention' });
    const context = withActiveMemories(makeContext(candidate), {
      convention: [{ id: 'mem-cyr', content: contradicting }],
    });
    const result = evaluateContradictionCheck(candidate, makeRule(), context);
    expect(result.outcome).toBe('flag');
    expect(result.reason).toContain('mem-cyr');
  });

  it('does not flag disjoint non-Latin texts (no empty-token-set collapse)', () => {
    const candidate = makeCandidate({
      content: 'Всегда проверяйте целостность резервных копий после каждого запуска',
      category: 'convention',
    });
    const context = withActiveMemories(makeContext(candidate), {
      convention: [
        { id: 'mem-other', content: '部署服務時必須先執行資料庫遷移然後重新啟動應用程式' },
      ],
    });
    const result = evaluateContradictionCheck(candidate, makeRule(), context);
    expect(result.outcome).toBe('pass');
  });
});
