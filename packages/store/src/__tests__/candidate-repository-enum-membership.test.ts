/**
 * Repository-layer enum-membership choke-point tests
 * (Epic 0 residual hardening, was compile-then-govern-c5k.5).
 *
 * The disclosure gate skips the closed-vocabulary fields (`status`, `source`,
 * `category`, `trustLevel`, `confidence`, `sensitivity`, `author.type`) by name -
 * safe only while those fields actually hold a vocabulary member. A RAW
 * `CandidateRepository.insert()` caller that bypassed `MemoryCandidate.parse()`
 * could otherwise plant an arbitrary string under an enum-constrained field and
 * ride the disclosure-scan skip into durable state.
 *
 * These tests drive the REAL `insert()` with hand-mutated candidates whose enum
 * fields carry off-vocabulary values, proving the repository now re-asserts enum
 * membership: a disclosure-shaped value smuggled into an enum field is rejected as
 * `DisclosureRejectedError` (with its precise category), an otherwise-invalid
 * non-vocabulary value is rejected as `EnumConstraintViolationError`, and a valid
 * enum value still passes. In every reject case the row never lands in the table.
 *
 * Secret-shaped test literals are fragmented with string concatenation so the
 * contiguous shape never appears in source.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DisclosureRejectedError } from '@qmd-team-intent-kb/common';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { CandidateRepository } from '../repositories/candidate-repository.js';
import { EnumConstraintViolationError } from '../repositories/enum-membership.js';
import { makeCandidate } from './fixtures.js';

/**
 * Build a structurally-valid candidate, then overwrite one enum-constrained field
 * with an off-vocabulary value AFTER the Zod parse - exactly what a raw `insert()`
 * caller that hand-built the object (skipping `MemoryCandidate.parse()`) would
 * produce. The cast is the test's way of bypassing the type-level guard the same
 * way an untyped/old-code-path caller bypasses it at runtime.
 */
function withRawEnumField(
  field: 'status' | 'source' | 'category' | 'trustLevel',
  rawValue: string,
): { candidate: MemoryCandidate; contentHash: string } {
  const { candidate, contentHash } = makeCandidate({
    content: 'clean technical body',
    title: 'clean title',
  });
  (candidate as Record<string, unknown>)[field] = rawValue;
  return { candidate, contentHash };
}

describe('CandidateRepository.insert - enum-membership choke point', () => {
  let db: Database.Database;
  let repo: CandidateRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new CandidateRepository(db);
  });

  // ---------------------------------------------------------------------------
  // The headline regression: an SSN-shaped value smuggled into `category` (a field
  // the disclosure scan SKIPS) must be rejected, and the row never written.
  // ---------------------------------------------------------------------------

  it('rejects a raw insert with an SSN-shaped category and never writes the row', () => {
    const { candidate, contentHash } = withRawEnumField('category', '123-45-' + '6789');
    let err: unknown;
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      err = e;
    }
    // SSN-shaped -> routed through the disclosure scan -> caught as PII.
    expect(err).toBeInstanceOf(DisclosureRejectedError);
    expect((err as DisclosureRejectedError).category).toBe('pii');
    expect(repo.count()).toBe(0);
    expect(repo.findById(candidate.id)).toBeNull();
  });

  it('rejects a compensation-shaped value smuggled into category (caught as compensation)', () => {
    const { candidate, contentHash } = withRawEnumField('category', 'his base salary leaked');
    let err: unknown;
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DisclosureRejectedError);
    expect((err as DisclosureRejectedError).category).toBe('compensation');
    expect(repo.count()).toBe(0);
  });

  it('rejects a credential / secret smuggled into source (caught as secret)', () => {
    const { candidate, contentHash } = withRawEnumField(
      'source',
      'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz12',
    );
    let err: unknown;
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DisclosureRejectedError);
    expect((err as DisclosureRejectedError).category).toBe('secret');
    expect(repo.count()).toBe(0);
  });

  it('rejects an off-vocabulary trustLevel that is NOT disclosure-shaped (EnumConstraintViolationError)', () => {
    const { candidate, contentHash } = withRawEnumField('trustLevel', 'super-trusted');
    let err: unknown;
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnumConstraintViolationError);
    expect((err as EnumConstraintViolationError).field).toBe('trustLevel');
    expect(repo.count()).toBe(0);
    expect(repo.findById(candidate.id)).toBeNull();
  });

  it('rejects an off-vocabulary status that is NOT disclosure-shaped (EnumConstraintViolationError)', () => {
    const { candidate, contentHash } = withRawEnumField('status', 'promoted');
    let err: unknown;
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnumConstraintViolationError);
    expect((err as EnumConstraintViolationError).field).toBe('status');
    expect(repo.count()).toBe(0);
  });

  it('rejects an SSN-shaped author.type and never writes the row', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'clean technical body',
      title: 'clean title',
      author: { type: 'human', id: 'u-1' },
    });
    (candidate.author as Record<string, unknown>).type = '123-45-' + '6789';
    let err: unknown;
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DisclosureRejectedError);
    expect((err as DisclosureRejectedError).category).toBe('pii');
    expect(repo.count()).toBe(0);
  });

  it('rejects an off-vocabulary metadata.sensitivity that is NOT disclosure-shaped', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'clean technical body',
      title: 'clean title',
      metadata: { filePaths: [], tags: [], sensitivity: 'internal' },
    });
    (candidate.metadata as Record<string, unknown>).sensitivity = 'ultra-secret-clearance';
    let err: unknown;
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnumConstraintViolationError);
    expect((err as EnumConstraintViolationError).field).toBe('metadata.sensitivity');
    expect(repo.count()).toBe(0);
  });

  it('does NOT echo the smuggled value in the EnumConstraintViolationError message (non-leak)', () => {
    const { candidate, contentHash } = withRawEnumField('trustLevel', 'leak-marker-zzz');
    let message = '';
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('leak-marker-zzz');
  });

  // ---------------------------------------------------------------------------
  // No false positives: a VALID enum value stays skipped and passes unchanged,
  // including a present-but-valid optional metadata enum.
  // ---------------------------------------------------------------------------

  it('allows a candidate whose enum fields all hold valid vocabulary values', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'always return Result<T, E> from the kernel for fallible ops',
      title: 'clean title',
      category: 'convention',
      trustLevel: 'high',
      source: 'manual',
      author: { type: 'human', id: 'jeremy' },
      metadata: {
        filePaths: [],
        tags: [],
        confidence: 'high',
        sensitivity: 'internal',
      },
    });
    expect(() => repo.insert(candidate, contentHash)).not.toThrow();
    expect(repo.count()).toBe(1);
    expect(repo.findById(candidate.id)?.category).toBe('convention');
  });

  it('allows a candidate with the optional metadata enums absent', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'always return Result<T, E> from the kernel for fallible ops',
      title: 'clean title',
      metadata: { filePaths: [], tags: [] },
    });
    expect(() => repo.insert(candidate, contentHash)).not.toThrow();
    expect(repo.count()).toBe(1);
  });
});
