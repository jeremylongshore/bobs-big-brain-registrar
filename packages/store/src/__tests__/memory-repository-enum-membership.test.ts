/**
 * MemoryRepository write-side enum-membership choke-point tests
 * (bead qmd-team-intent-kb-5bm.1).
 *
 * `assertEnumMembership` guarded only the candidates table; nothing guarded
 * `curated_memories` — the highest-trust table. `MemoryRepository.insert/update`
 * bind the enum columns raw, and `MemoryRowSchema` validates only on READ, so a
 * raw caller (or a bypassed promotion path) could plant an arbitrary — or
 * disclosure-shaped — string in an enum column of the governed store, where the
 * disclosure scan skips it by name.
 *
 * These tests drive the REAL `insert()`/`update()` with hand-mutated memories
 * whose enum fields carry off-vocabulary values, proving the repository now
 * re-asserts membership on write: a disclosure-shaped value is rejected as
 * `DisclosureRejectedError` (precise category), an otherwise-invalid value as
 * `EnumConstraintViolationError`, and a valid enum value still passes. In every
 * reject case the row never lands.
 *
 * Secret-shaped test literals are fragmented with string concatenation so the
 * contiguous shape never appears in source.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DisclosureRejectedError } from '@qmd-team-intent-kb/common';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { MemoryRepository } from '../repositories/memory-repository.js';
import { EnumConstraintViolationError } from '../repositories/enum-membership.js';
import { makeMemory } from './fixtures.js';

/**
 * Build a structurally-valid memory, then overwrite one enum-constrained field
 * with an off-vocabulary value AFTER the Zod parse — exactly what a raw caller
 * that hand-built the object (skipping `CuratedMemory.parse()`) would produce.
 */
function withRawEnumField(field: string, rawValue: string): CuratedMemory {
  const memory = makeMemory({ title: 'clean title', content: 'clean technical body' });
  (memory as Record<string, unknown>)[field] = rawValue;
  return memory;
}

describe('MemoryRepository.insert — enum-membership choke point', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryRepository(db);
  });

  it('inserts a fully-valid memory (no false positive)', () => {
    const memory = makeMemory();
    expect(() => repo.insert(memory)).not.toThrow();
    expect(repo.findById(memory.id)).not.toBeNull();
  });

  it.each([
    ['category', 'made-up-category'],
    ['trustLevel', 'super-high'],
    ['sensitivity', 'top-secret'],
    ['lifecycle', 'zombie'],
    ['source', 'telepathy'],
  ])('rejects an off-vocabulary %s as EnumConstraintViolationError', (field, bad) => {
    const memory = withRawEnumField(field, bad);
    expect(() => repo.insert(memory)).toThrow(EnumConstraintViolationError);
    // The row never landed.
    expect(repo.findById(memory.id)).toBeNull();
    expect(repo.count()).toBe(0);
  });

  it('rejects an off-vocabulary author.type', () => {
    const memory = makeMemory();
    (memory.author as Record<string, unknown>).type = 'demigod';
    expect(() => repo.insert(memory)).toThrow(EnumConstraintViolationError);
    expect(repo.count()).toBe(0);
  });

  it('rejects a disclosure-shaped value smuggled into an enum field with its category', () => {
    // An SSN-shaped value planted in `category` must be caught as a disclosure
    // violation (precise category), not the generic enum error — the enum field
    // is skipped by the disclosure scan by name, which is exactly the gap.
    const memory = withRawEnumField('category', '123' + '-45-' + '6789');
    expect(() => repo.insert(memory)).toThrow(DisclosureRejectedError);
    expect(repo.count()).toBe(0);
  });

  it('names only the field, never the rejected value, in the error', () => {
    const memory = withRawEnumField('trustLevel', 'ultra-trusted');
    try {
      repo.insert(memory);
      expect.unreachable('insert should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnumConstraintViolationError);
      expect((e as EnumConstraintViolationError).message).not.toContain('ultra-trusted');
      expect((e as EnumConstraintViolationError).field).toBe('trustLevel');
    }
  });
});

describe('MemoryRepository.update — enum-membership choke point', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryRepository(db);
  });

  it('rejects an off-vocabulary enum value on update (not a back door)', () => {
    const memory = makeMemory();
    repo.insert(memory);
    const tampered = { ...memory, category: 'fabricated' } as unknown as CuratedMemory;
    expect(() => repo.update(tampered)).toThrow(EnumConstraintViolationError);
    // The stored row is unchanged.
    expect(repo.findById(memory.id)?.category).toBe(memory.category);
  });

  it('allows a valid enum change on update', () => {
    const memory = makeMemory({ category: 'reference' });
    repo.insert(memory);
    const updated = {
      ...memory,
      category: 'decision' as const,
      updatedAt: '2026-03-01T00:00:00.000Z',
    };
    expect(() => repo.update(updated)).not.toThrow();
    expect(repo.findById(memory.id)?.category).toBe('decision');
  });
});
