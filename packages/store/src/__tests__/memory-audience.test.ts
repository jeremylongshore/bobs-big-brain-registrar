/**
 * Claim-level audience at the store layer (Epic K bead K2).
 *
 * Proves the "zero store migration" claim on a real SQLite database: the value
 * lives inside the existing `metadata_json` column, a row written before the
 * field existed reads back unchanged, and an off-vocabulary value is refused at
 * the write choke point for both tables.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audience } from '@qmd-team-intent-kb/schema';
import type { CuratedMemory, MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  AUDIENCE_RANK,
  computeContentHash,
  isAudienceVisibleToRole,
} from '@qmd-team-intent-kb/common';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { MemoryRepository } from '../repositories/memory-repository.js';
import { CandidateRepository } from '../repositories/candidate-repository.js';
import { EnumConstraintViolationError } from '../repositories/enum-membership.js';
import { makeCandidate, makeMemory } from './fixtures.js';

describe('audience vocabulary alignment (schema enum <-> common rank table)', () => {
  it('AUDIENCE_RANK lists exactly the Audience enum members, in the same widest-first order', () => {
    expect(Object.keys(AUDIENCE_RANK)).toEqual([...Audience.options]);
  });

  it('every enum member is a tier the read predicate recognizes (the owner can read it)', () => {
    for (const audience of Audience.options) {
      expect(isAudienceVisibleToRole(audience, 'owner')).toBe(true);
    }
  });
});

describe('curated_memories — audience rides in metadata_json (no migration)', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryRepository(db);
  });
  afterEach(() => db.close());

  const rawMetadata = (id: string): string =>
    (
      db.prepare('SELECT metadata_json FROM curated_memories WHERE id = ?').get(id) as {
        metadata_json: string;
      }
    ).metadata_json;

  it('has no audience column — the schema is untouched', () => {
    const columns = (
      db.prepare("PRAGMA table_info('curated_memories')").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).not.toContain('audience');
    expect(columns).toContain('metadata_json');
  });

  it.each(Audience.options)('round-trips audience %s through insert and read', (audience) => {
    const memory = makeMemory({ metadata: { filePaths: [], tags: [], audience } });
    repo.insert(memory);
    expect(repo.findById(memory.id)?.metadata.audience).toBe(audience);
    expect(JSON.parse(rawMetadata(memory.id))).toMatchObject({ audience });
  });

  it('a memory with no audience stores no audience key and reads back without one', () => {
    const memory = makeMemory();
    repo.insert(memory);
    expect(rawMetadata(memory.id)).not.toContain('audience');
    const read = repo.findById(memory.id);
    expect(read?.metadata.audience).toBeUndefined();
    expect(read).toEqual(memory);
  });

  it('a pre-K2 row (written by raw SQL, no audience) reads back unchanged and tenant-visible', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const content = 'legacy memory written before the audience field existed';
    const legacyMetadata = '{"filePaths":["src/a.ts"],"tags":["legacy"]}';
    db.prepare(
      `INSERT INTO curated_memories (
         id, candidate_id, source, content, title, category, trust_level, sensitivity,
         author_json, tenant_id, metadata_json, lifecycle, content_hash,
         policy_evaluations_json, supersession_json, promoted_at, promoted_by_json,
         updated_at, version
       ) VALUES (
         @id, @cid, 'manual', @content, 'Legacy row', 'reference', 'high', 'internal',
         @author, 'team-alpha', @metadata, 'active', @hash,
         '[]', NULL, @at, @author, @at, 1
       )`,
    ).run({
      id,
      cid: '22222222-2222-4222-8222-222222222222',
      content,
      author: JSON.stringify({ type: 'human', id: 'user-1' }),
      metadata: legacyMetadata,
      hash: computeContentHash(content),
      at: '2026-01-15T10:00:00.000Z',
    });

    const read = repo.findById(id);
    expect(read).not.toBeNull();
    expect(read!.metadata).toEqual({ filePaths: ['src/a.ts'], tags: ['legacy'] });
    // Re-serializing what was read reproduces the stored bytes: nothing was added.
    expect(JSON.stringify(read!.metadata)).toBe(legacyMetadata);
    for (const role of ['member', 'admin', 'owner']) {
      expect(isAudienceVisibleToRole(read!.metadata.audience, role)).toBe(true);
    }
  });

  it('refuses an off-vocabulary audience on insert, and the row never lands', () => {
    const memory = makeMemory();
    (memory.metadata as Record<string, unknown>)['audience'] = 'board';
    expect(() => repo.insert(memory)).toThrow(EnumConstraintViolationError);
    expect(repo.findById(memory.id)).toBeNull();
  });

  it('refuses an off-vocabulary audience on update, leaving the stored row as it was', () => {
    const memory = makeMemory({ metadata: { filePaths: [], tags: [], audience: 'admins' } });
    repo.insert(memory);
    const tampered: CuratedMemory = {
      ...memory,
      metadata: { ...memory.metadata, audience: 'everyone' as never },
    };
    expect(() => repo.update(tampered)).toThrow(EnumConstraintViolationError);
    expect(repo.findById(memory.id)?.metadata.audience).toBe('admins');
  });

  it('names only the field in the error, never the rejected value', () => {
    const memory = makeMemory();
    (memory.metadata as Record<string, unknown>)['audience'] = 'zz-rejected-value-zz';
    try {
      repo.insert(memory);
      expect.unreachable('insert should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnumConstraintViolationError);
      expect((err as EnumConstraintViolationError).field).toBe('metadata.audience');
      expect((err as Error).message).not.toContain('zz-rejected-value-zz');
    }
  });

  it('a row whose stored audience is off-vocabulary is unreadable, not silently widened', () => {
    const memory = makeMemory();
    repo.insert(memory);
    db.prepare('UPDATE curated_memories SET metadata_json = ? WHERE id = ?').run(
      '{"filePaths":[],"tags":[],"audience":"board"}',
      memory.id,
    );
    expect(() => repo.findById(memory.id)).toThrow(/audience/);
  });
});

describe('candidates — audience declared at capture', () => {
  let db: Database.Database;
  let repo: CandidateRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new CandidateRepository(db);
  });
  afterEach(() => db.close());

  it.each(Audience.options)('persists a candidate declaring audience %s', (audience) => {
    const { candidate, contentHash } = makeCandidate({
      metadata: { filePaths: [], tags: [], audience },
    });
    repo.insert(candidate, contentHash);
    expect(repo.findById(candidate.id)?.metadata.audience).toBe(audience);
  });

  it('refuses a candidate carrying an off-vocabulary audience', () => {
    const made = makeCandidate();
    const candidate: MemoryCandidate = made.candidate;
    (candidate.metadata as Record<string, unknown>)['audience'] = 'board';
    expect(() => repo.insert(candidate, made.contentHash)).toThrow(EnumConstraintViolationError);
    expect(repo.findById(candidate.id)).toBeNull();
  });
});
