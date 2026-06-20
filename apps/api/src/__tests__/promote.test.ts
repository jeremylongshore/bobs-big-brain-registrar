import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
} from '@qmd-team-intent-kb/store';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { buildApp } from '../app.js';
import { makeCandidate, makeMemory, makePolicy } from './fixtures.js';

/**
 * POST /api/candidates/:id/promote — the one-shot candidate→governed-memory
 * endpoint (bead 3iu.2). buildApp({ db }) runs in dev mode = admin, so these
 * functional tests don't need a token; the admin-gating is covered in
 * write-gate.test.ts.
 */
describe('POST /api/candidates/:id/promote', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let candidateRepo: CandidateRepository;
  let memoryRepo: MemoryRepository;
  let policyRepo: PolicyRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
    memoryRepo = new MemoryRepository(db);
    policyRepo = new PolicyRepository(db);
    app = buildApp({ db, silent: true });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function promote(id: string, tenantId?: string) {
    const q = tenantId === undefined ? '' : `?tenantId=${tenantId}`;
    return app.inject({ method: 'POST', url: `/api/candidates/${id}/promote${q}` });
  }

  it('promotes an inbox candidate to a governed memory (200)', async () => {
    const candidate = makeCandidate({ tenantId: 'team-alpha' });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));

    const res = await promote(candidate.id, 'team-alpha');
    expect(res.statusCode).toBe(200);
    const memory = res.json() as { id: string; candidateId: string; lifecycle: string };
    expect(memory.candidateId).toBe(candidate.id);
    expect(memory.lifecycle).toBe('active');
    // It is now a real, retrievable governed memory.
    expect(memoryRepo.findById(memory.id)).not.toBeNull();
  });

  it('returns 400 when tenantId is missing', async () => {
    const candidate = makeCandidate();
    candidateRepo.insert(candidate, computeContentHash(candidate.content));
    const res = await promote(candidate.id);
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a non-existent candidate', async () => {
    const res = await promote(randomUUID(), 'team-alpha');
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when the candidate belongs to a different tenant', async () => {
    const candidate = makeCandidate({ tenantId: 'team-alpha' });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));
    const res = await promote(candidate.id, 'team-beta');
    expect(res.statusCode).toBe(400);
  });

  it('returns 422 when the content is already promoted (dedup)', async () => {
    const content = 'content that is already in the governed store';
    const hash = computeContentHash(content);
    const candidate = makeCandidate({ content, tenantId: 'team-alpha' });
    candidateRepo.insert(candidate, hash);
    memoryRepo.insert(makeMemory({ contentHash: hash, tenantId: 'team-alpha' }));

    const res = await promote(candidate.id, 'team-alpha');
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/already promoted/i);
  });

  it('returns 422 and leaves the candidate in the inbox when policy rejects', async () => {
    // Default makePolicy carries a secret_detection rule with action 'reject'.
    policyRepo.insert(makePolicy({ tenantId: 'team-alpha' }));
    const candidate = makeCandidate({
      content: 'deploy with AWS key AKIAIOSFODNN7EXAMPLE in the config',
      tenantId: 'team-alpha',
    });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));

    const res = await promote(candidate.id, 'team-alpha');
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/rejected by policy/i);
    // The candidate is untouched — still in the inbox for a retry after a policy fix.
    expect(candidateRepo.findById(candidate.id)).not.toBeNull();
  });
});
