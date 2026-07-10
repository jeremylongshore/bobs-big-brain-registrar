import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { CandidateRepository } from '../repositories/candidate-repository.js';
import { makeCandidate } from './fixtures.js';

/**
 * B1 (bead compile-then-govern-jfv.2.1) — the auto-govern sweep's non-destructive
 * status primitives on CandidateRepository: findByStatus (tenant-scoped, tolerant
 * read) + updateStatus (in-place marker, never a delete).
 */
describe('CandidateRepository — status marker (B1)', () => {
  let db: Database.Database;
  let repo: CandidateRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new CandidateRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('findByStatus returns only rows in that status AND tenant', () => {
    const { candidate: a, contentHash: ha } = makeCandidate({
      tenantId: 't1',
      content: 'aaa aaa aaa',
    });
    const { candidate: b, contentHash: hb } = makeCandidate({
      tenantId: 't1',
      content: 'bbb bbb bbb',
    });
    const { candidate: c, contentHash: hc } = makeCandidate({
      tenantId: 't2',
      content: 'ccc ccc ccc',
    });
    repo.insert(a, ha);
    repo.insert(b, hb);
    repo.insert(c, hc);

    // All three start in the inbox.
    expect(repo.findByStatus('inbox', 't1')).toHaveLength(2);
    expect(repo.findByStatus('inbox', 't2')).toHaveLength(1);

    // Retire one of t1's candidates → it leaves the t1 inbox.
    expect(repo.updateStatus(a.id, 'promoted')).toBe(1);
    const inboxT1 = repo.findByStatus('inbox', 't1');
    expect(inboxT1.map((x) => x.id)).toEqual([b.id]);
    expect(repo.findByStatus('promoted', 't1').map((x) => x.id)).toEqual([a.id]);
    // t2 is untouched by t1's sweep.
    expect(repo.findByStatus('inbox', 't2')).toHaveLength(1);
  });

  it('updateStatus stamps the marker in place and never deletes the row', () => {
    const { candidate, contentHash } = makeCandidate({ tenantId: 't1' });
    repo.insert(candidate, contentHash);

    const changed = repo.updateStatus(candidate.id, 'quarantined');
    expect(changed).toBe(1);

    // Row still present — its content survives (Tier-A source of truth).
    const row = repo.findById(candidate.id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('quarantined');
    expect(row?.content).toBe(candidate.content);
    expect(repo.count()).toBe(1);
  });

  it('updateStatus returns 0 for an unknown id (no row changed)', () => {
    expect(repo.updateStatus('11111111-1111-4111-8111-111111111111', 'promoted')).toBe(0);
  });

  it('updateStatus rejects a value outside the closed CandidateStatus vocabulary', () => {
    const { candidate, contentHash } = makeCandidate();
    repo.insert(candidate, contentHash);
    // @ts-expect-error — off-vocabulary status is a type error AND a runtime throw.
    expect(() => repo.updateStatus(candidate.id, 'not-a-real-status')).toThrow();
    // The row is untouched — still inbox.
    expect(repo.findById(candidate.id)?.status).toBe('inbox');
  });

  it('findByStatus is TOLERANT — one unparseable row is skipped+reported, not thrown', () => {
    const { candidate: good, contentHash: hg } = makeCandidate({
      tenantId: 't1',
      content: 'good good good',
    });
    repo.insert(good, hg);

    // Corrupt a row directly at the SQL layer (bypass the repo's validating insert)
    // to simulate a truncated/legacy row: invalid author_json.
    db.prepare(
      `INSERT INTO candidates (id, status, source, content, title, category, trust_level,
        author_json, tenant_id, metadata_json, pre_policy_flags_json, content_hash, captured_at)
       VALUES (@id,'inbox','mcp','x','x','reference','medium','{not json',@tenant,'{}','{}',@hash,@at)`,
    ).run({
      id: '22222222-2222-4222-8222-222222222222',
      tenant: 't1',
      hash: 'f'.repeat(64),
      at: '2026-01-15T10:00:00.000Z',
    });

    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const inbox = repo.findByStatus('inbox', 't1');
    // The good row is returned; the corrupt one is dropped (not thrown).
    expect(inbox.map((x) => x.id)).toEqual([good.id]);
    // The skip was reported to stderr with the bad row's id (never content).
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('22222222-2222-4222-8222-222222222222');
    warn.mockRestore();
  });
});
