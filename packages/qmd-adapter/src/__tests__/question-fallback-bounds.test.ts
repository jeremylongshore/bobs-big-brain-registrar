import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Fts5Backend } from '../native/fts5-backend.js';

describe('question fallback refusal bounds', () => {
  let backend: Fts5Backend;
  beforeEach(() => {
    backend = new Fts5Backend();
  });
  afterEach(() => backend.close());

  const scope = ['kb-curated'];
  const answer = { id: 'answer', collection: 'kb-curated', content: 'alpha beta' };

  it('refuses a single topical term', () => {
    backend.insert([answer]);
    expect(backend.searchQuestionFallback('where is alpha', 10, scope)).toEqual([]);
  });

  it('accepts 25,000 documents and refuses 25,001, even when the extra documents are out of scope', () => {
    backend.insert([
      answer,
      ...Array.from({ length: 24999 }, (_, i) => ({
        id: `noise-${i}`,
        collection: 'kb-archive',
        content: 'padding',
      })),
    ]);
    expect(
      backend.searchQuestionFallback('where are alpha beta', 10, scope).map((h) => h.id),
    ).toEqual(['answer']);
    backend.insert([{ id: 'extra', collection: 'kb-archive', content: 'padding' }]);
    expect(backend.searchQuestionFallback('where are alpha beta', 10, scope)).toEqual([]);
  });

  it('accepts 2,000 scoped postings for one term and refuses 2,001', () => {
    backend.insert([
      answer,
      ...Array.from({ length: 1999 }, (_, i) => ({
        id: `noise-${i}`,
        collection: 'kb-curated',
        content: 'alpha',
      })),
    ]);
    expect(
      backend.searchQuestionFallback('where are alpha beta', 10, scope).map((h) => h.id),
    ).toEqual(['answer']);
    backend.insert([{ id: 'extra', collection: 'kb-curated', content: 'alpha' }]);
    expect(backend.searchQuestionFallback('where are alpha beta', 10, scope)).toEqual([]);
  });

  it('applies collection scope before counting per-term postings', () => {
    backend.insert([
      answer,
      ...Array.from({ length: 2001 }, (_, i) => ({
        id: `archive-${i}`,
        collection: 'kb-archive',
        content: 'alpha beta',
      })),
    ]);
    expect(
      backend.searchQuestionFallback('where are alpha beta', 10, scope).map((h) => h.id),
    ).toEqual(['answer']);
    expect(backend.searchQuestionFallback('where are alpha beta', 10)).toEqual([]);
  });

  it('accepts 10,000 total postings and refuses 10,001 with every individual term below its cap', () => {
    const terms = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    backend.insert([
      { ...answer, content: terms.join(' ') },
      ...terms.flatMap((term, index) =>
        Array.from({ length: index < 4 ? 1666 : 1665 }, (_, i) => ({
          id: `${term}-${i}`,
          collection: 'kb-curated',
          content: term,
        })),
      ),
    ]);
    const query = 'where are ' + terms.join(' ');
    expect(backend.searchQuestionFallback(query, 10, scope).map((h) => h.id)).toEqual(['answer']);
    backend.insert([{ id: 'extra', collection: 'kb-curated', content: 'alpha' }]);
    expect(backend.searchQuestionFallback(query, 10, scope)).toEqual([]);
  });

  it('holds one read snapshot from the probes through ranking while another connection commits', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'qmd-question-snapshot-'));
    const path = join(scratch, 'native.sqlite');
    const reader = new Database(path);
    const snapshotBackend = new Fts5Backend({ db: reader });
    const writer = new Fts5Backend({ path });
    const originalPrepare = reader.prepare.bind(reader);
    let inTransaction = false;
    const prepare = vi.spyOn(reader, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('WITH term_matches')) {
        prepare.mockRestore();
        inTransaction = reader.inTransaction;
        writer.insert(
          Array.from({ length: 2001 }, (_, i) => ({
            id: `concurrent-${i}`,
            collection: 'kb-curated',
            content: 'alpha beta',
          })),
        );
      }
      return originalPrepare(sql);
    });
    try {
      snapshotBackend.insert([{ ...answer, content: 'alpha beta ' + 'padding '.repeat(1000) }]);
      expect(
        snapshotBackend.searchQuestionFallback('where are alpha beta', 10, scope).map((h) => h.id),
      ).toEqual(['answer']);
      expect(inTransaction).toBe(true);
      // The next transaction sees the committed growth and refuses it.
      expect(snapshotBackend.searchQuestionFallback('where are alpha beta', 10, scope)).toEqual([]);
    } finally {
      prepare.mockRestore();
      snapshotBackend.close();
      writer.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
