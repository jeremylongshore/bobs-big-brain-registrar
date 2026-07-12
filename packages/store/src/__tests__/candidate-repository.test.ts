import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { CandidateRepository } from '../repositories/candidate-repository.js';
import { makeCandidate } from './fixtures.js';

const NOW = '2026-01-15T10:00:00.000Z';

describe('CandidateRepository', () => {
  let db: Database.Database;
  let repo: CandidateRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new CandidateRepository(db);
  });

  it('inserts a candidate and retrieves it by id', () => {
    const { candidate, contentHash } = makeCandidate();
    repo.insert(candidate, contentHash);
    const found = repo.findById(candidate.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(candidate.id);
    expect(found?.content).toBe(candidate.content);
    expect(found?.title).toBe(candidate.title);
    expect(found?.status).toBe('inbox');
  });

  it('findByTenant returns only candidates for the matching tenant', () => {
    const { candidate: c1, contentHash: h1 } = makeCandidate({ tenantId: 'team-alpha' });
    const { candidate: c2, contentHash: h2 } = makeCandidate({
      tenantId: 'team-beta',
      content: 'different content',
    });
    repo.insert(c1, h1);
    repo.insert(c2, h2);

    const alphaResults = repo.findByTenant('team-alpha');
    expect(alphaResults).toHaveLength(1);
    expect(alphaResults[0]?.tenantId).toBe('team-alpha');

    const betaResults = repo.findByTenant('team-beta');
    expect(betaResults).toHaveLength(1);
    expect(betaResults[0]?.tenantId).toBe('team-beta');
  });

  it('findByContentHash returns the matching candidate', () => {
    const { candidate, contentHash } = makeCandidate();
    repo.insert(candidate, contentHash);
    const found = repo.findByContentHash(contentHash);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(candidate.id);
  });

  it('findByContentHashAndTenant is tenant-scoped — same content, other tenant → null (jfv.9)', () => {
    // team-alpha and team-beta both store the SAME content.
    const { candidate: a, contentHash } = makeCandidate({
      tenantId: 'team-alpha',
      content: 'shared body',
    });
    const { candidate: b } = makeCandidate({ tenantId: 'team-beta', content: 'shared body' });
    repo.insert(a, contentHash);
    repo.insert(b, contentHash);
    // The dedup lookup only ever returns the caller's OWN tenant's row.
    expect(repo.findByContentHashAndTenant(contentHash, 'team-alpha')?.id).toBe(a.id);
    expect(repo.findByContentHashAndTenant(contentHash, 'team-beta')?.id).toBe(b.id);
    // A tenant with no such content gets null (not another tenant's row).
    expect(repo.findByContentHashAndTenant(contentHash, 'team-gamma')).toBeNull();
  });

  it('count returns the correct number of candidates', () => {
    expect(repo.count()).toBe(0);
    const { candidate: c1, contentHash: h1 } = makeCandidate();
    const { candidate: c2, contentHash: h2 } = makeCandidate({ content: 'second candidate' });
    repo.insert(c1, h1);
    expect(repo.count()).toBe(1);
    repo.insert(c2, h2);
    expect(repo.count()).toBe(2);
  });

  it('returns null for a non-existent id', () => {
    expect(repo.findById(randomUUID())).toBeNull();
  });

  it('preserves full metadata on insert and retrieval', () => {
    const { candidate, contentHash } = makeCandidate({
      metadata: {
        filePaths: ['src/api.ts', 'src/auth.ts'],
        language: 'typescript',
        projectContext: 'backend',
        tags: ['api', 'auth'],
      },
      prePolicyFlags: { potentialSecret: true, lowConfidence: false, duplicateSuspect: true },
    });
    repo.insert(candidate, contentHash);
    const found = repo.findById(candidate.id);
    expect(found?.metadata.filePaths).toEqual(['src/api.ts', 'src/auth.ts']);
    expect(found?.metadata.language).toBe('typescript');
    expect(found?.prePolicyFlags.potentialSecret).toBe(true);
    expect(found?.prePolicyFlags.duplicateSuspect).toBe(true);
  });

  it('multiple inserts produce a correct count', () => {
    for (let i = 0; i < 5; i++) {
      const { candidate, contentHash } = makeCandidate({ content: `content-${i.toString()}` });
      repo.insert(candidate, contentHash);
    }
    expect(repo.count()).toBe(5);
  });

  it('handles special characters in content without corruption', () => {
    const specialContent = `Use "double-quotes", 'single-quotes', <tags>, & ampersands\nnewlines\ttabs`;
    const { candidate, contentHash } = makeCandidate({ content: specialContent });
    repo.insert(candidate, contentHash);
    const found = repo.findById(candidate.id);
    expect(found?.content).toBe(specialContent);
    expect(found && computeContentHash(found.content)).toBe(contentHash);
  });
});

describe('CandidateRepository — aggregation queries', () => {
  let db: Database.Database;
  let repo: CandidateRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new CandidateRepository(db);
  });

  it('countByTenant returns empty record when no candidates exist', () => {
    expect(repo.countByTenant()).toEqual({});
  });

  it('countByTenant returns correct counts per tenant', () => {
    const { candidate: c1, contentHash: h1 } = makeCandidate({ tenantId: 'team-alpha' });
    const { candidate: c2, contentHash: h2 } = makeCandidate({
      tenantId: 'team-alpha',
      content: 'second alpha content',
    });
    const { candidate: c3, contentHash: h3 } = makeCandidate({
      tenantId: 'team-beta',
      content: 'beta content',
    });
    repo.insert(c1, h1);
    repo.insert(c2, h2);
    repo.insert(c3, h3);
    const counts = repo.countByTenant();
    expect(counts['team-alpha']).toBe(2);
    expect(counts['team-beta']).toBe(1);
    expect(counts['team-gamma']).toBeUndefined();
  });

  it('countByTenant updates correctly after additional inserts', () => {
    const { candidate: c1, contentHash: h1 } = makeCandidate({ tenantId: 'team-alpha' });
    repo.insert(c1, h1);
    expect(repo.countByTenant()['team-alpha']).toBe(1);
    const { candidate: c2, contentHash: h2 } = makeCandidate({
      tenantId: 'team-alpha',
      content: 'another memory for alpha',
    });
    repo.insert(c2, h2);
    expect(repo.countByTenant()['team-alpha']).toBe(2);
  });
});

describe('CandidateRepository — Zod-on-read malformed row rejection', () => {
  let db: Database.Database;
  let repo: CandidateRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new CandidateRepository(db);
  });

  it('throws a descriptive error when author_json contains invalid JSON', () => {
    // Insert a row with malformed author_json directly via raw SQL to simulate DB corruption
    const id = randomUUID();
    db.prepare(
      `
      INSERT INTO candidates (
        id, status, source, content, title, category,
        trust_level, author_json, tenant_id,
        metadata_json, pre_policy_flags_json, content_hash, captured_at
      ) VALUES (
        ?, 'inbox', 'claude_session', 'Some content', 'Some title', 'convention',
        'medium', 'NOT_VALID_JSON', 'team-alpha',
        '{}', '{}', ?, ?
      )
    `,
    ).run(id, 'a'.repeat(64), NOW);

    expect(() => repo.findById(id)).toThrowError(
      /candidates row id=.+: author_json is not valid JSON/,
    );
  });

  it('throws a descriptive error when status contains an invalid enum value', () => {
    // Insert a row with an invalid status value to simulate DB schema drift or manual edit
    const id = randomUUID();
    const validAuthor = JSON.stringify({ type: 'ai', id: 'session-1', name: 'Claude' });
    db.prepare(
      `
      INSERT INTO candidates (
        id, status, source, content, title, category,
        trust_level, author_json, tenant_id,
        metadata_json, pre_policy_flags_json, content_hash, captured_at
      ) VALUES (
        ?, 'INVALID_STATUS_VALUE', 'claude_session', 'Some content', 'Some title', 'convention',
        'medium', ?, 'team-alpha',
        '{}', '{}', ?, ?
      )
    `,
    ).run(id, validAuthor, 'b'.repeat(64), NOW);

    expect(() => repo.findById(id)).toThrowError(/candidates row id=.+ failed domain validation/);
  });
});
