import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  createDatabase,
  CandidateRepository,
  MemoryRepository,
  AuditRepository,
  PolicyRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { Curator } from '@qmd-team-intent-kb/curator';
import { buildRecommendedPolicy } from '@qmd-team-intent-kb/policy-engine';
import { buildApp } from '../app.js';
import { PromotionService } from '../services/promotion-service.js';
import { makeCandidate, makeMemory } from './fixtures.js';

describe('atomic existing API reviewer rejection', () => {
  let root: string;
  let db: Database.Database;
  let app: FastifyInstance;
  let candidates: CandidateRepository;
  let memories: MemoryRepository;
  let audit: AuditRepository;
  let policies: PolicyRepository;
  const tenant = 'reviewer-fixture';
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'bbb-api-reviewer-'));
    db = createDatabase({ path: join(root, 'fixture.db') });
    candidates = new CandidateRepository(db);
    memories = new MemoryRepository(db);
    audit = new AuditRepository(db);
    policies = new PolicyRepository(db);
    app = buildApp({ db, silent: true });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  function seed(status: 'inbox' | 'quarantined' | 'rejected' | 'promoted' = 'inbox') {
    const candidate = makeCandidate({ tenantId: tenant, status });
    candidates.insert(candidate, computeContentHash(candidate.content));
    return candidate;
  }
  const view = () =>
    Object.fromEntries(
      ['candidates', 'curated_memories', 'audit_events'].map((table) => [
        table,
        db
          .prepare(`SELECT * FROM ${table} ORDER BY ${table === 'audit_events' ? 'seq' : 'id'}`)
          .all(),
      ]),
    );
  const reject = (id: string, scope = tenant) =>
    app.inject({
      method: 'POST',
      url: `/api/candidates/${id}/reject?tenantId=${scope}`,
      payload: { actorType: 'ai', reason: 'Synthetic reviewer disposition' },
    });

  for (const fault of ['receipt-abort', 'receipt-ignore', 'status-ignore']) {
    it(`${fault} rolls back all selected state and succeeds after removing only the fault`, async () => {
      const candidate = seed();
      const before = view();
      const chain = verifyAuditChain(audit);
      db.exec(
        fault === 'status-ignore'
          ? `CREATE TRIGGER review_fault BEFORE UPDATE OF status ON candidates WHEN NEW.status='rejected' BEGIN SELECT RAISE(IGNORE); END;`
          : `CREATE TRIGGER review_fault BEFORE INSERT ON audit_events WHEN NEW.action='deleted' BEGIN SELECT RAISE(${fault === 'receipt-ignore' ? 'IGNORE' : "ABORT, 'fixture audit fault'"}); END;`,
      );
      expect((await reject(candidate.id)).statusCode).toBe(500);
      expect(view()).toEqual(before);
      expect(verifyAuditChain(audit)).toEqual(chain);
      db.exec('DROP TRIGGER review_fault');
      expect((await reject(candidate.id)).statusCode).toBe(200);
      expect(candidates.findById(candidate.id)).toMatchObject({
        status: 'rejected',
        content: candidate.content,
      });
      expect(audit.findByMemoryAndTenant(candidate.id, tenant)).toHaveLength(1);
    });
  }
  for (const status of ['inbox', 'quarantined'] as const) {
    it(`preserves AI rejection of ${status} proposals and refuses a repeat without a receipt`, async () => {
      const candidate = seed(status);
      expect((await reject(candidate.id)).statusCode).toBe(200);
      const events = audit.findByMemoryAndTenant(candidate.id, tenant);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'deleted',
        actor: { type: 'ai' },
        details: { candidateId: candidate.id, disposition: 'rejected' },
      });
      const before = view();
      const repeated = await reject(candidate.id);
      expect(repeated.statusCode).toBe(422);
      expect(repeated.json()).toMatchObject({ code: 'not_pending' });
      expect(view()).toEqual(before);
    });
  }
  for (const status of ['rejected', 'promoted'] as const) {
    it(`refuses terminal ${status} proposals unchanged`, async () => {
      const candidate = seed(status);
      const before = view();
      expect((await reject(candidate.id)).statusCode).toBe(422);
      expect(view()).toEqual(before);
    });
  }
  for (const lifecycle of ['active', 'archived', 'superseded', 'deprecated'] as const) {
    it(`refuses a stale inbox row linked to an ${lifecycle} memory`, async () => {
      const candidate = seed();
      memories.insert(makeMemory({ candidateId: candidate.id, tenantId: tenant, lifecycle }));
      const before = view();
      const reply = await reject(candidate.id);
      expect(reply.statusCode).toBe(422);
      expect(reply.json()).toMatchObject({ code: 'not_pending' });
      expect(view()).toEqual(before);
    });
  }
  it('preserves tenant refusal without changing rows', async () => {
    const candidate = seed();
    const before = view();
    expect((await reject(candidate.id, 'another-tenant')).statusCode).toBe(400);
    expect(view()).toEqual(before);
  });
  it('keeps canonical human holds out of the reviewer rejection path', async () => {
    policies.insert(buildRecommendedPolicy(tenant, new Date().toISOString()));
    const candidate = makeCandidate({
      tenantId: tenant,
      category: 'onboarding',
      content:
        'Contact fixture@example.invalid for invented service coordination and application documentation.',
    });
    candidates.insert(candidate, computeContentHash(candidate.content));
    expect(
      new Curator(
        { candidateRepo: candidates, memoryRepo: memories, auditRepo: audit, policyRepo: policies },
        { tenantId: tenant },
      ).processSingle(candidate).outcome,
    ).toBe('held');
    const before = view();
    const reply = await reject(candidate.id);
    expect(reply.statusCode).toBe(422);
    expect(reply.json()).toMatchObject({ code: 'on_hold' });
    expect(view()).toEqual(before);
  });
  it('uses a nested transaction that rolls back with the callers outer failure', () => {
    const candidate = seed();
    const before = view();
    const service = new PromotionService(candidates, memories, policies, audit);
    expect(() =>
      db
        .transaction(() => {
          service.rejectCandidate(
            candidate.id,
            tenant,
            { type: 'system', id: 'fixture-reviewer' },
            'Fixture system review',
          );
          expect(candidates.findById(candidate.id)?.status).toBe('rejected');
          throw new Error('outer fault');
        })
        .immediate(),
    ).toThrow('outer fault');
    expect(view()).toEqual(before);
  });
});
