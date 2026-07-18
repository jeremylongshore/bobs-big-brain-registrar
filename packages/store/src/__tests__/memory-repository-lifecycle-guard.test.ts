/**
 * MemoryRepository.updateLifecycle state-graph guard tests (bead qmd-team-intent-kb-5bm.4).
 *
 * validateTransition (schema/lifecycle.ts) was enforced only at app entry
 * points; updateLifecycle was a raw UPDATE, so an illegal transition
 * (archived -> active, superseded -> deprecated, ...) could be written directly.
 * These tests drive the real updateLifecycle and prove the repository now
 * rejects transitions the state graph forbids, allows the legal ones, treats a
 * same-state call as an idempotent no-op, and leaves a missing row as false.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { MemoryRepository, InvalidLifecycleTransitionError } from '../index.js';
import { makeMemory } from './fixtures.js';

const LATER = '2026-03-01T00:00:00.000Z';

describe('MemoryRepository.updateLifecycle — state-graph guard', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryRepository(db);
  });

  function seed(lifecycle: 'active' | 'deprecated' | 'superseded' | 'archived') {
    // superseded requires supersession metadata in the schema; keep it simple by
    // seeding non-superseded start states for the graph tests, and drive INTO
    // superseded only where the transition is legal.
    const memory = makeMemory({ lifecycle });
    repo.insert(memory);
    return memory;
  }

  it('allows a legal transition (active -> deprecated)', () => {
    const m = seed('active');
    expect(() => repo.updateLifecycle(m.id, 'deprecated', LATER)).not.toThrow();
    expect(repo.findById(m.id)?.lifecycle).toBe('deprecated');
  });

  it('allows active -> archived', () => {
    const m = seed('active');
    expect(repo.updateLifecycle(m.id, 'archived', LATER)).toBe(true);
    expect(repo.findById(m.id)?.lifecycle).toBe('archived');
  });

  it('rejects an illegal transition (archived -> active)', () => {
    const m = seed('archived');
    expect(() => repo.updateLifecycle(m.id, 'active', LATER)).toThrow(
      InvalidLifecycleTransitionError,
    );
    expect(repo.findById(m.id)?.lifecycle).toBe('archived'); // unchanged
  });

  it('rejects deprecated -> superseded (not in the graph)', () => {
    const m = seed('deprecated');
    expect(() => repo.updateLifecycle(m.id, 'superseded', LATER)).toThrow(
      InvalidLifecycleTransitionError,
    );
  });

  it('treats a same-state call as an idempotent no-op', () => {
    const m = seed('active');
    expect(() => repo.updateLifecycle(m.id, 'active', LATER)).not.toThrow();
    expect(repo.findById(m.id)?.lifecycle).toBe('active');
  });

  it('returns false for a missing memory (never throws)', () => {
    expect(repo.updateLifecycle('00000000-0000-4000-8000-000000000000', 'archived', LATER)).toBe(
      false,
    );
  });

  it('names only the states, never content, in the error', () => {
    const m = seed('archived');
    try {
      repo.updateLifecycle(m.id, 'deprecated', LATER);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidLifecycleTransitionError);
      expect((e as InvalidLifecycleTransitionError).from).toBe('archived');
      expect((e as InvalidLifecycleTransitionError).to).toBe('deprecated');
    }
  });
});
