import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeContentHash } from '@qmd-team-intent-kb/common';
import type { Author, CandidateStatus } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createDatabase,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Curator, rejectReviewedCandidate } from '../index.js';
import type { ReviewedRejectionInput } from '../index.js';
import { placeHold } from '../hold/hold.js';
import { makeCandidate, makeMemory, TENANT } from './fixtures.js';

let root: string;
let db: ReturnType<typeof createDatabase>;
let candidates: CandidateRepository;
let audit: AuditRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reviewed-rejection-'));
  db = createDatabase({ path: join(root, 'teamkb.db') });
  candidates = new CandidateRepository(db);
  audit = new AuditRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function seed(overrides: Parameters<typeof makeCandidate>[0] = {}): string {
  const candidate = makeCandidate(overrides);
  candidates.insert(candidate, computeContentHash(candidate.content));
  return candidate.id;
}

function input(
  candidateId: string,
  overrides: Partial<ReviewedRejectionInput> = {},
): ReviewedRejectionInput {
  return {
    candidateId,
    tenantId: TENANT,
    actor: { type: 'human', id: 'fixture-reviewer' },
    role: 'owner',
    reason: 'Reviewed as redundant source material.',
    ...overrides,
  };
}

function snapshot(): unknown {
  return {
    candidates: db.prepare('SELECT * FROM candidates ORDER BY id').all(),
    memories: db.prepare('SELECT * FROM curated_memories ORDER BY id').all(),
    audit: db.prepare('SELECT * FROM audit_events ORDER BY seq').all(),
  };
}

describe('person-reviewed pending rejection on a real file-backed store', () => {
  it('retains the candidate and attributes one canonical chained receipt to the person', () => {
    const id = seed();
    const before = candidates.findById(id)!;
    const result = rejectReviewedCandidate(input(id), db);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected rejection to commit');
    expect(candidates.findById(id)).toEqual({ ...before, status: 'rejected' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM curated_memories').get()).toEqual({ n: 0 });
    const events = audit.findByTenant(TENANT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: result.auditEventId,
      action: 'deleted',
      memoryId: id,
      tenantId: TENANT,
      actor: input(id).actor,
      reason: input(id).reason,
      details: { candidateId: id, disposition: 'rejected', resolverRole: 'owner' },
    });
    expect(events[0]!.details).not.toHaveProperty('content');
    expect(events[0]!.details).not.toHaveProperty('title');
    expect(verifyAuditChain(audit)).toMatchObject({
      totalRows: 1,
      cleanRows: 1,
      unverifiedRows: 0,
      breaks: [],
    });
    db.close();
    db = createDatabase({ path: join(root, 'teamkb.db'), readonly: true });
    expect(new CandidateRepository(db).findById(id)?.status).toBe('rejected');
    expect(new AuditRepository(db).findByTenant(TENANT)).toEqual(events);
  });

  it('repeats without another receipt or status change', () => {
    const id = seed();
    expect(rejectReviewedCandidate(input(id), db).ok).toBe(true);
    const before = snapshot();
    expect(rejectReviewedCandidate(input(id), db)).toEqual({
      ok: false,
      candidateId: id,
      code: 'not_pending',
    });
    expect(snapshot()).toEqual(before);
  });

  it('refuses a canonical direct promotion whose candidate still says inbox', () => {
    const id = seed();
    const memories = new MemoryRepository(db);
    const curator = new Curator(
      {
        candidateRepo: candidates,
        memoryRepo: memories,
        policyRepo: new PolicyRepository(db),
        auditRepo: audit,
      },
      { tenantId: TENANT },
    );
    expect(curator.processSingle(candidates.findById(id)!).outcome).toBe('promoted');
    expect(candidates.findById(id)?.status).toBe('inbox');
    expect(memories.existsForCandidate(id, TENANT)).toBe(true);
    expect(memories.findByTenant(TENANT)).toHaveLength(1);
    const before = snapshot();
    expect(rejectReviewedCandidate(input(id), db)).toEqual({
      ok: false,
      candidateId: id,
      code: 'not_pending',
    });
    expect(snapshot()).toEqual(before);
    expect(verifyAuditChain(audit)).toMatchObject({ totalRows: 1, cleanRows: 1, breaks: [] });
  });

  it('refuses archived linked memories with non-derived IDs and keeps the lookup tenant scoped', () => {
    const id = seed();
    const memories = new MemoryRepository(db);
    const memory = makeMemory({ candidateId: id, tenantId: TENANT, lifecycle: 'archived' });
    memories.insert(memory);
    expect(memories.existsForCandidate(id, TENANT)).toBe(true);
    expect(memories.existsForCandidate(id, 'foreign-tenant')).toBe(false);
    expect(memories.existsForCandidate(randomUUID(), TENANT)).toBe(false);
    const before = snapshot();
    expect(rejectReviewedCandidate(input(id), db)).toEqual({
      ok: false,
      candidateId: id,
      code: 'not_pending',
    });
    expect(snapshot()).toEqual(before);
  });

  it('records actor and reason with canonical whitespace normalization', () => {
    const id = seed();
    expect(
      rejectReviewedCandidate(
        input(id, { actor: { type: 'human', id: ' reviewer ' }, reason: ' Reviewed. ' }),
        db,
      ).ok,
    ).toBe(true);
    expect(audit.findByTenant(TENANT)[0]).toMatchObject({
      actor: { type: 'human', id: 'reviewer' },
      reason: 'Reviewed.',
    });
  });

  it.each([
    ['missing_reason', { reason: undefined }],
    ['missing_reason', { reason: null }],
    ['missing_reason', { reason: 42 }],
    ['missing_actor', { actor: undefined }],
    ['missing_actor', { actor: null }],
    ['missing_actor', { actor: { type: 'human' } }],
    ['missing_actor', { actor: { type: 'human', id: 42 } }],
    ['not_human', { actor: { type: 'ai' } }],
  ] as const)('defensively refuses malformed review fields: %s (%j)', (code, overrides) => {
    const id = seed();
    // Deliberately bypass TS at a prospective JSON boundary; no repo writes.
    const request = { ...input(id), ...overrides } as unknown as ReviewedRejectionInput;
    const before = snapshot();
    expect(rejectReviewedCandidate(request, db)).toEqual({ ok: false, candidateId: id, code });
    expect(snapshot()).toEqual(before);
  });

  it('propagates canonical schema failure without changing the candidate', () => {
    const id = seed();
    const before = snapshot();
    expect(() =>
      rejectReviewedCandidate(
        input(id, {
          actor: { type: 'human', id: 'reviewer', name: null } as unknown as Author,
        }),
        db,
      ),
    ).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('checks authority before repeat state when a later caller has lower standing', () => {
    const id = seed({ metadata: { filePaths: [], tags: [], audience: 'owner' } });
    expect(rejectReviewedCandidate(input(id), db).ok).toBe(true);
    const before = snapshot();
    expect(rejectReviewedCandidate(input(id, { role: 'admin' }), db)).toEqual({
      ok: false,
      candidateId: id,
      code: 'audience_above_standing',
    });
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ['missing_reason', { reason: '  ' }],
    ['missing_actor', { actor: { type: 'human', id: ' ' } }],
    ['not_human', { actor: { type: 'ai', id: 'fixture-agent' } }],
    ['not_human', { actor: { type: 'system', id: 'fixture-system' } }],
    ['forbidden_role', { role: 'member' }],
    ['forbidden_role', { role: 'unknown' }],
    ['not_found', { tenantId: 'foreign-tenant' }],
    ['not_found', { candidateId: randomUUID() }],
  ] as const)('refuses %s without writes (%j)', (code, overrides) => {
    const id = seed();
    const request = input(id, overrides);
    const before = snapshot();
    expect(rejectReviewedCandidate(request, db)).toEqual({
      ok: false,
      candidateId: request.candidateId,
      code,
    });
    expect(snapshot()).toEqual(before);
  });

  it.each([
    'promoted',
    'rejected',
    'flagged',
    'duplicate',
    'quarantined',
  ] satisfies CandidateStatus[])('refuses non-inbox status %s without writes', (status) => {
    const id = seed({ status });
    const before = snapshot();
    expect(rejectReviewedCandidate(input(id), db)).toEqual({
      ok: false,
      candidateId: id,
      code: 'not_pending',
    });
    expect(snapshot()).toEqual(before);
  });

  it('keeps a real active hold for the canonical hold resolver', () => {
    const id = seed();
    const result = placeHold(
      candidates.findById(id)!,
      {
        triggers: ['audience_narrowing_flag'],
        declaredAudience: 'tenant',
        recommendedAudience: 'admins',
        basis: 'pii',
        matchedPatterns: [],
        triggerRuleIds: ['fixture-audience'],
        otherFlags: [],
      },
      { candidateRepo: candidates, memoryRepo: new MemoryRepository(db), auditRepo: audit },
    );
    expect(result.status).toBe('held');
    const before = snapshot();
    expect(rejectReviewedCandidate(input(id), db)).toEqual({
      ok: false,
      candidateId: id,
      code: 'on_hold',
    });
    expect(snapshot()).toEqual(before);
  });

  it('requires owner standing for owner-audience work, but permits an admin for tenant work', () => {
    const id = seed({ metadata: { filePaths: [], tags: [], audience: 'owner' } });
    const before = snapshot();
    expect(rejectReviewedCandidate(input(id, { role: 'admin' }), db)).toEqual({
      ok: false,
      candidateId: id,
      code: 'audience_above_standing',
    });
    expect(snapshot()).toEqual(before);
    expect(rejectReviewedCandidate(input(id), db).ok).toBe(true);
    const tenantId = seed();
    expect(rejectReviewedCandidate(input(tenantId, { role: 'admin' }), db).ok).toBe(true);
    expect(audit.findByTenant(TENANT)).toHaveLength(2);
    expect(verifyAuditChain(audit)).toMatchObject({ totalRows: 2, cleanRows: 2, breaks: [] });
  });

  it('rolls back both status and appended receipt on a real audit INSERT failure, then retries once', () => {
    expect(rejectReviewedCandidate(input(seed()), db).ok).toBe(true);
    const id = seed();
    const before = snapshot();
    db.exec(
      "CREATE TRIGGER fixture_audit_failure AFTER INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END",
    );
    expect(() => rejectReviewedCandidate(input(id), db)).toThrow('fixture audit failure');
    expect(snapshot()).toEqual(before);
    db.exec('DROP TRIGGER fixture_audit_failure');
    expect(rejectReviewedCandidate(input(id), db).ok).toBe(true);
    expect(audit.findByTenant(TENANT)).toHaveLength(2);
    expect(verifyAuditChain(audit)).toMatchObject({ totalRows: 2, cleanRows: 2, breaks: [] });
  });

  it('rolls back a silently ignored audit insert and preserves the prior chain tip', () => {
    expect(rejectReviewedCandidate(input(seed()), db).ok).toBe(true);
    const id = seed();
    const before = snapshot();
    db.exec(
      'CREATE TRIGGER fixture_audit_ignore BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END',
    );
    expect(() => rejectReviewedCandidate(input(id), db)).toThrow(
      'Reviewed rejection receipt was not persisted',
    );
    expect(snapshot()).toEqual(before);
    expect(verifyAuditChain(audit)).toMatchObject({ totalRows: 1, cleanRows: 1, breaks: [] });
    db.exec('DROP TRIGGER fixture_audit_ignore');
    expect(rejectReviewedCandidate(input(id), db).ok).toBe(true);
    expect(audit.findByTenant(TENANT)).toHaveLength(2);
    expect(verifyAuditChain(audit)).toMatchObject({ totalRows: 2, cleanRows: 2, breaks: [] });
  });

  it.each(['ABORT', 'IGNORE'] as const)(
    'writes no success receipt if a status trigger uses %s',
    (mode) => {
      const id = seed();
      const before = snapshot();
      const abort = mode === 'ABORT' ? "RAISE(ABORT, 'fixture status failure')" : 'RAISE(IGNORE)';
      db.exec(
        `CREATE TRIGGER fixture_status_failure BEFORE UPDATE OF status ON candidates BEGIN SELECT ${abort}; END`,
      );
      expect(() => rejectReviewedCandidate(input(id), db)).toThrow();
      expect(snapshot()).toEqual(before);
    },
  );
});
