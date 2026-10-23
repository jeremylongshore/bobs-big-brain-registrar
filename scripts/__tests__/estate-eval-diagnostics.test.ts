import { EmbedFailure } from '../../packages/qmd-adapter/src/dense/embed-client.js';
import { describe, expect, it } from 'vitest';
import { classifyDenseFailure, EstateDenseDiagnostics } from '../lib/estate-eval-diagnostics.js';

describe('estate evaluation diagnostics', () => {
  it.each([
    ['dense arm unavailable after construction', 'construction-unavailable'],
    ['dense index is empty or unbuilt', 'unbuilt-or-empty'],
    ['query vector dimension does not match dense index', 'dimension-mismatch'],
  ])('classifies %s', (message, category) => {
    expect(classifyDenseFailure(new Error(message))).toBe(category);
  });
  it('does not trust a diagnostic class with a mutated category', () => {
    const failure = new EmbedFailure('timeout');
    Object.defineProperty(failure, 'category', { value: 'PRIVATE-CANARY' });
    Object.defineProperty(failure, 'message', { value: 'PRIVATE-CANARY' });
    expect(classifyDenseFailure(failure)).toBe('query-failure');
  });
  it('never copies unknown error payloads into the report', () => {
    const canary = 'PRIVATE-DIAGNOSTIC-CANARY';
    for (const error of [new Error(canary), canary, { message: canary }, null]) {
      expect(classifyDenseFailure(error)).toBe('query-failure');
      expect(classifyDenseFailure(error)).not.toContain(canary);
    }
  });
});

describe('query-local dense diagnostic receipts', () => {
  it('attributes concurrent scored/gap failures and omits private payloads', async () => {
    const diagnostics = new EstateDenseDiagnostics();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scored = diagnostics.run({ phase: 'scored', queryId: 'e03' }, async () => {
      await gate;
      diagnostics.observe(new EmbedFailure('timeout'));
    });
    await diagnostics.run({ phase: 'gap', queryId: 'g04' }, async () => {
      diagnostics.observe(new EmbedFailure('http-error', 503));
    });
    release();
    await scored;
    diagnostics.observe(new Error('PRIVATE-PROMPT /home/private TOKEN'));
    expect(diagnostics.events).toEqual([
      { phase: 'gap', queryId: 'g04', category: 'http-error', httpStatus: 503 },
      { phase: 'scored', queryId: 'e03', category: 'timeout' },
      { phase: 'unattributed', queryId: null, category: 'query-failure' },
    ]);
    expect(diagnostics.categories).toEqual({ 'http-error': 1, timeout: 1, 'query-failure': 1 });
    expect(diagnostics.total).toBe(3);
    expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE|home|TOKEN/);
  });

  it('omits unsafe IDs, bounds event storage and preserves complete aggregate counts', async () => {
    const diagnostics = new EstateDenseDiagnostics();
    await diagnostics.run({ phase: 'scored', queryId: 'PRIVATE /home/path' }, async () => {
      diagnostics.observe(new EmbedFailure('http-error', 9999));
    });
    expect(diagnostics.events[0]).toEqual({
      phase: 'unattributed',
      queryId: null,
      category: 'http-error',
    });
    for (let i = 0; i < 1004; i++) diagnostics.observe(new EmbedFailure('timeout'));
    expect(diagnostics.events).toHaveLength(1000);
    expect(diagnostics.droppedEvents).toBe(5);
    expect(diagnostics.total).toBe(1005);
    expect(diagnostics.categories['timeout']).toBe(1004);
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE');
  });
});
