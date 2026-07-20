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

  function promote(id: string, tenantId?: string, payload?: Record<string, unknown>) {
    const q = tenantId === undefined ? '' : `?tenantId=${tenantId}`;
    return app.inject({
      method: 'POST',
      url: `/api/candidates/${id}/promote${q}`,
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  /** Insert a candidate row directly at the SQL layer, BYPASSING the repository's
   * disclosure choke — the only way to plant a secret-bearing row so the
   * promote-time disclosure hard floor (014-AT-DECR #1) can be exercised. */
  function insertRawCandidate(id: string, tenantId: string, content: string): void {
    db.prepare(
      `INSERT INTO candidates (id, status, source, content, title, category, trust_level,
        author_json, tenant_id, metadata_json, pre_policy_flags_json, content_hash, captured_at)
       VALUES (@id,'quarantined','mcp',@content,'raw','reference','medium',
        @author,@tenant,'{}','{}',@hash,@at)`,
    ).run({
      id,
      content,
      author: JSON.stringify({ type: 'ai', id: 'governed-brain' }),
      tenant: tenantId,
      hash: computeContentHash(content),
      at: '2026-07-11T10:00:00.000Z',
    });
  }

  /** The single 'promoted' audit event for a memory, actor + reason parsed. */
  function promotedEvent(memoryId: string): {
    actor: { type: string; id: string };
    reason: string;
  } {
    const row = db
      .prepare(
        `SELECT actor_json, reason FROM audit_events WHERE action='promoted' AND memory_id=@memoryId`,
      )
      .get({ memoryId }) as { actor_json: string; reason: string };
    return { actor: JSON.parse(row.actor_json), reason: row.reason };
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

  it('does not treat another tenant’s identical content as a duplicate (tenant-scoped dedup)', async () => {
    const content = 'a shared convention that two teams both wrote down';
    const hash = computeContentHash(content);
    // team-beta already has this exact content as a governed memory.
    memoryRepo.insert(makeMemory({ contentHash: hash, tenantId: 'team-beta' }));
    // team-alpha proposes the same content — must NOT be blocked as a duplicate.
    const candidate = makeCandidate({ content, tenantId: 'team-alpha' });
    candidateRepo.insert(candidate, hash);

    const res = await promote(candidate.id, 'team-alpha');
    expect(res.statusCode).toBe(200);
  });

  it('flips the candidate to `promoted` so it leaves the inbox (jfv.8 status-flip fix)', async () => {
    // Regression for the confirmed status-flip bug: before jfv.8, promote()
    // inserted the memory but never touched the candidates row, so an approved
    // candidate kept its status and re-appeared in brain_inbox forever.
    const candidate = makeCandidate({ tenantId: 'team-alpha' });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));
    expect(candidateRepo.findById(candidate.id)?.status).toBe('inbox');

    const res = await promote(candidate.id, 'team-alpha');
    expect(res.statusCode).toBe(200);
    // The candidate row survives (Tier-A) but is now retired from the queue.
    expect(candidateRepo.findById(candidate.id)?.status).toBe('promoted');
  });

  it('records the acting reviewer + reason on the promoted receipt (014-AT-DECR #2)', async () => {
    const candidate = makeCandidate({ tenantId: 'team-alpha' });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));

    const res = await promote(candidate.id, 'team-alpha', {
      actorType: 'ai',
      reason: 'high-confidence durable convention',
    });
    expect(res.statusCode).toBe(200);
    const memory = res.json() as { id: string };
    const ev = promotedEvent(memory.id);
    // The receipt is filterable by the AI reviewer, and carries its verdict.
    expect(ev.actor.type).toBe('ai');
    expect(ev.reason).toMatch(/high-confidence durable convention/);
    expect(ev.reason).toMatch(/passed all governance rules/);
  });

  it('REJECTS a secret-bearing candidate at the promotion disclosure hard floor (014-AT-DECR #1)', async () => {
    // A secret can't normally reach the inbox (intake blocks it), so plant one
    // directly to prove the promote path is unlaunderable on its own — an agent's
    // "promote" can NEVER move a secret into durable memory, policy config or not.
    const id = randomUUID();
    insertRawCandidate(id, 'team-alpha', 'deploy key AKIAIOSFODNN7EXAMPLE for the bucket');

    const res = await promote(id, 'team-alpha');
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/disclosure gate/i);
    // Nothing was promoted and the candidate was NOT marked promoted.
    expect(candidateRepo.findById(id)?.status).toBe('quarantined');
  });

  it('returns 422 and leaves the candidate in the inbox when policy rejects', async () => {
    // Default makePolicy carries a secret_detection rule with action 'reject'.
    policyRepo.insert(makePolicy({ tenantId: 'team-alpha' }));
    // This content must trip the POLICY-ENGINE secret scanner (which is broader)
    // WITHOUT tripping the boundary disclosure choke point on insert (Epic 0) —
    // otherwise it never reaches the inbox to be promote-tested. A GCP
    // service-account marker is policy-flagged but not a boundary-gate pattern.
    const candidate = makeCandidate({
      content: 'config snippet includes "type": "service_account" for the deploy',
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

/**
 * POST /api/candidates/:id/reject — the agent-review "this is noise, stop
 * proposing it" verdict (jfv.8 / 014-AT-DECR). A non-destructive status flip +
 * an on-chain receipt naming the reviewer. buildApp({ db }) = dev/admin, so the
 * admin gating itself is covered in write-gate.test.ts.
 */
describe('POST /api/candidates/:id/reject', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let candidateRepo: CandidateRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
    app = buildApp({ db, silent: true });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function reject(id: string, tenantId?: string, payload?: Record<string, unknown>) {
    const q = tenantId === undefined ? '' : `?tenantId=${tenantId}`;
    return app.inject({
      method: 'POST',
      url: `/api/candidates/${id}/reject${q}`,
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  it('marks the candidate `rejected` in place and writes a receipt naming the reviewer', async () => {
    const candidate = makeCandidate({ tenantId: 'team-alpha' });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));

    const res = await reject(candidate.id, 'team-alpha', {
      actorType: 'ai',
      reason: 'duplicate of an existing convention — noise',
    });
    expect(res.statusCode).toBe(200);
    // Row survives (Tier-A, never deleted) but is retired as rejected.
    const row = candidateRepo.findById(candidate.id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('rejected');
    // A 'deleted'-action receipt names the AI reviewer + carries the reason.
    const ev = db
      .prepare(
        `SELECT actor_json, reason FROM audit_events WHERE action='deleted' AND memory_id=@id`,
      )
      .get({ id: candidate.id }) as { actor_json: string; reason: string };
    expect(JSON.parse(ev.actor_json).type).toBe('ai');
    expect(ev.reason).toMatch(/duplicate of an existing convention/);
  });

  it('requires a non-empty reason (400)', async () => {
    const candidate = makeCandidate({ tenantId: 'team-alpha' });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));
    const res = await reject(candidate.id, 'team-alpha', { actorType: 'ai' });
    expect(res.statusCode).toBe(400);
    // Untouched — still awaiting review.
    expect(candidateRepo.findById(candidate.id)?.status).toBe('inbox');
  });

  it('returns 400 when tenantId is missing', async () => {
    const candidate = makeCandidate({ tenantId: 'team-alpha' });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));
    const res = await reject(candidate.id, undefined, { reason: 'noise' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a non-existent candidate', async () => {
    const res = await reject(randomUUID(), 'team-alpha', { reason: 'noise' });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * Import exclusion gate on the single-candidate admin path (bead 5kw.1) —
 * the same structural brainignore check the curator batch pipeline runs, so
 * both paths agree (the H1 invariant). Committed defaults only; the per-brain
 * override file is wired where the service is constructed.
 */
describe('POST /api/candidates/:id/promote — import exclusion gate (5kw.1)', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let candidateRepo: CandidateRepository;
  let memoryRepo: MemoryRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
    memoryRepo = new MemoryRepository(db);
    app = buildApp({ db, silent: true });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function promote(id: string, tenantId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/candidates/${id}/promote?tenantId=${tenantId}`,
    });
  }

  it('refuses an import-source candidate on a vendored path (422, left in inbox)', async () => {
    const candidate = makeCandidate({
      tenantId: 'team-alpha',
      source: 'import',
      metadata: { filePaths: ['node_modules/@google-cloud/storage/README.md'], tags: [] },
    });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));

    const res = await promote(candidate.id, 'team-alpha');
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; code?: string };
    expect(body.error).toContain('import exclusion gate');
    expect(body.error).toContain('node_modules');
    expect(body.code).toBe('brainignore_path');
    // Left in the inbox for review — never silently retired.
    expect(candidateRepo.findById(candidate.id)?.status).toBe('inbox');
    expect(memoryRepo.findByTenant('team-alpha')).toEqual([]);

    // RECEIPT PARITY (PR #309 finding 1): the rejection is on the append-only
    // audit chain, exactly as the curator batch path receipts via reject().
    // Without this assertion the earlier version threw a 422 with NO audit row,
    // and the inbox-retention + no-memory checks alone let that asymmetry pass.
    const rejectRow = db
      .prepare(
        `SELECT action, reason, details_json FROM audit_events
         WHERE action='deleted' AND memory_id=@id`,
      )
      .get({ id: candidate.id }) as
      { action: string; reason: string; details_json: string } | undefined;
    expect(rejectRow).toBeDefined();
    expect(rejectRow!.reason).toContain('brainignore_path');
    const details = JSON.parse(rejectRow!.details_json) as {
      candidateId: string;
      outcome: string;
      evaluations: Array<{ ruleId: string; ruleType: string; reason: string }>;
    };
    expect(details.candidateId).toBe(candidate.id);
    expect(details.outcome).toBe('rejected');
    expect(details.evaluations[0]?.ruleId).toBe('brainignore_path');
    expect(details.evaluations[0]?.ruleType).toBe('import_exclusion');
    expect(details.evaluations[0]?.reason).toContain('node_modules');
  });

  it('promotes an identical candidate from an interactive source (gate not applicable)', async () => {
    const candidate = makeCandidate({
      tenantId: 'team-alpha',
      source: 'mcp',
      metadata: { filePaths: ['node_modules/@google-cloud/storage/README.md'], tags: [] },
    });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));

    const res = await promote(candidate.id, 'team-alpha');
    expect(res.statusCode).toBe(200);
  });
});
