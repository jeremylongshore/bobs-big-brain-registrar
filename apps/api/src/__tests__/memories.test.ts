import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase, MemoryRepository, AuditRepository } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';
import { makeMemory, makeTransitionBody, NOW } from './fixtures.js';

describe('/api/memories', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let memoryRepo: MemoryRepository;
  let auditRepo: AuditRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    // Repositories for direct seeding
    memoryRepo = new MemoryRepository(db);
    auditRepo = new AuditRepository(db);
    app = buildApp({ db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  // ---- GET /api/memories/:id -----------------------------------------------

  it('GET /:id returns the stored memory', () => {
    const memory = makeMemory();
    memoryRepo.insert(memory);

    return app.inject({ method: 'GET', url: `/api/memories/${memory.id}` }).then((res) => {
      expect(res.statusCode).toBe(200);
      expect(res.json<{ id: string }>().id).toBe(memory.id);
    });
  });

  it('GET /:id for non-existent returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${randomUUID()}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toMatch(/not found/i);
  });

  // ---- GET /api/memories ---------------------------------------------------

  it('GET list with tenantId returns memories for that tenant', async () => {
    const alpha = makeMemory({ tenantId: 'team-alpha' });
    const beta = makeMemory({
      tenantId: 'team-beta',
      contentHash: 'b'.repeat(64),
      content: 'Beta-specific memory',
    });
    memoryRepo.insert(alpha);
    memoryRepo.insert(beta);

    const res = await app.inject({
      method: 'GET',
      url: '/api/memories?tenantId=team-alpha',
    });
    expect(res.statusCode).toBe(200);
    const list = res.json<Array<{ tenantId: string }>>();
    expect(list.every((m) => m.tenantId === 'team-alpha')).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it('GET list without tenantId returns empty array', async () => {
    const memory = makeMemory();
    memoryRepo.insert(memory);

    const res = await app.inject({ method: 'GET', url: '/api/memories' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  // ---- GET /api/memories/by-hash/:hash ------------------------------------

  it('GET /by-hash/:hash returns the matching memory', async () => {
    const memory = makeMemory();
    memoryRepo.insert(memory);

    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/by-hash/${memory.contentHash}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ id: string }>().id).toBe(memory.id);
  });

  it('GET /by-hash/:hash for unknown hash returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/by-hash/${'c'.repeat(64)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- POST /api/memories/:id/transition ----------------------------------

  it('POST /:id/transition performs a valid active→deprecated transition', async () => {
    const memory = makeMemory({ lifecycle: 'active' });
    memoryRepo.insert(memory);

    const res = await app.inject({
      method: 'POST',
      url: `/api/memories/${memory.id}/transition`,
      payload: { to: 'deprecated', ...makeTransitionBody() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ lifecycle: string }>().lifecycle).toBe('deprecated');
  });

  it('POST /:id/transition with invalid target state returns 400', async () => {
    const memory = makeMemory({ lifecycle: 'active' });
    memoryRepo.insert(memory);

    const res = await app.inject({
      method: 'POST',
      url: `/api/memories/${memory.id}/transition`,
      payload: { to: 'not-a-real-state', ...makeTransitionBody() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /:id/transition with disallowed transition returns 400', async () => {
    // archived → active is not allowed
    const memory = makeMemory({ lifecycle: 'archived' });
    memoryRepo.insert(memory);

    const res = await app.inject({
      method: 'POST',
      url: `/api/memories/${memory.id}/transition`,
      payload: { to: 'active', ...makeTransitionBody() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/not allowed/i);
  });

  it('POST /:id/transition creates an audit event', async () => {
    const memory = makeMemory({ lifecycle: 'active', tenantId: 'team-audit' });
    memoryRepo.insert(memory);

    await app.inject({
      method: 'POST',
      url: `/api/memories/${memory.id}/transition`,
      payload: { to: 'deprecated', ...makeTransitionBody() },
    });

    const events = auditRepo.findByMemory(memory.id);
    expect(events.length).toBe(1);
    expect(events[0]?.action).toBe('demoted');
    expect(events[0]?.memoryId).toBe(memory.id);
  });

  it('POST /:id/transition to superseded requires supersededBy', async () => {
    const memory = makeMemory({ lifecycle: 'active' });
    memoryRepo.insert(memory);

    const res = await app.inject({
      method: 'POST',
      url: `/api/memories/${memory.id}/transition`,
      payload: { to: 'superseded', ...makeTransitionBody() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/supersededBy/i);
  });

  it('POST /:id/transition for non-existent memory returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/memories/${randomUUID()}/transition`,
      payload: { to: 'archived', ...makeTransitionBody() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /:id/transition active→archived records correct audit action', async () => {
    const memory = makeMemory({
      lifecycle: 'active',
      tenantId: 'team-archive-test',
    });
    memoryRepo.insert(memory);

    await app.inject({
      method: 'POST',
      url: `/api/memories/${memory.id}/transition`,
      payload: {
        to: 'archived',
        reason: 'Archiving old content',
        actor: { type: 'human', id: 'user-1', name: 'Test User' },
      },
    });

    const events = auditRepo.findByMemory(memory.id);
    expect(events[0]?.action).toBe('archived');
  });

  it('POST /:id/transition with missing actor returns 400', async () => {
    const memory = makeMemory({ lifecycle: 'active' });
    memoryRepo.insert(memory);

    const res = await app.inject({
      method: 'POST',
      url: `/api/memories/${memory.id}/transition`,
      payload: { to: 'deprecated', reason: 'Reason without actor' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('transition to superseded with supersededBy succeeds', async () => {
    const memory = makeMemory({ lifecycle: 'active' });
    const replacement = makeMemory({ tenantId: memory.tenantId });
    const replacementId = replacement.id;
    memoryRepo.insert(memory);
    memoryRepo.insert(replacement);

    const res = await app.inject({
      method: 'POST',
      url: `/api/memories/${memory.id}/transition`,
      payload: {
        to: 'superseded',
        reason: 'Replaced by newer approach',
        actor: { type: 'human', id: 'user-1', name: 'Test User' },
        supersededBy: replacementId,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ lifecycle: string }>().lifecycle).toBe('superseded');
    const reread = memoryRepo.findById(memory.id);
    expect(reread?.supersession).toMatchObject({
      supersededBy: replacementId,
      reason: 'Replaced by newer approach',
    });
    expect(auditRepo.findByMemory(memory.id)[0]?.details).toMatchObject({
      supersededBy: replacementId,
    });
  });

  it.each(['nonexistent', 'self', 'cross-tenant', 'inactive'])(
    'refuses %s supersession replacement without writes',
    async (kind) => {
      const memory = makeMemory();
      const replacement = makeMemory({
        tenantId: kind === 'cross-tenant' ? 'other-tenant' : memory.tenantId,
        lifecycle: kind === 'inactive' ? 'deprecated' : 'active',
      });
      memoryRepo.insert(memory);
      memoryRepo.insert(replacement);
      const supersededBy =
        kind === 'nonexistent' ? randomUUID() : kind === 'self' ? memory.id : replacement.id;
      const response = await app.inject({
        method: 'POST',
        url: `/api/memories/${memory.id}/transition`,
        payload: { to: 'superseded', ...makeTransitionBody(), supersededBy },
      });
      expect(response.statusCode).toBe(400);
      expect(memoryRepo.findById(memory.id)?.lifecycle).toBe('active');
      expect(memoryRepo.findById(memory.id)?.supersession).toBeUndefined();
      expect(auditRepo.findByMemory(memory.id)).toEqual([]);
    },
  );

  it('rolls back the supersession link and lifecycle if the audit insert fails', async () => {
    const memory = makeMemory();
    const replacement = makeMemory({ tenantId: memory.tenantId });
    memoryRepo.insert(memory);
    memoryRepo.insert(replacement);
    db.exec(
      "CREATE TRIGGER refuse_supersession_receipt BEFORE INSERT ON audit_events WHEN NEW.action = 'superseded' BEGIN SELECT RAISE(ABORT, 'fixture-audit-refusal'); END",
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/memories/${memory.id}/transition`,
      payload: { to: 'superseded', ...makeTransitionBody(), supersededBy: replacement.id },
    });
    expect(response.statusCode).toBe(500);
    expect(memoryRepo.findById(memory.id)?.lifecycle).toBe('active');
    expect(memoryRepo.findById(memory.id)?.supersession).toBeUndefined();
    expect(memoryRepo.findById(memory.id)?.updatedAt).toBe(memory.updatedAt);
    expect(auditRepo.findByMemory(memory.id)).toEqual([]);
  });

  it('transition preserves updatedAt after state change', async () => {
    const memory = makeMemory({ lifecycle: 'active', updatedAt: NOW });
    memoryRepo.insert(memory);

    const res = await app.inject({
      method: 'POST',
      url: `/api/memories/${memory.id}/transition`,
      payload: { to: 'archived', ...makeTransitionBody() },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json<{ updatedAt: string }>();
    // updatedAt should have changed from the seed value
    expect(updated.updatedAt).not.toBe(NOW);
  });
});
