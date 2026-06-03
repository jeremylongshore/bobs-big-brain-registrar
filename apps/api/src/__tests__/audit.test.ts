import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase, AuditRepository } from '@qmd-team-intent-kb/store';
import type { AuditEvent } from '@qmd-team-intent-kb/schema';
import { buildApp } from '../app.js';
import { NOW } from './fixtures.js';

describe('GET /api/audit', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let auditRepo: AuditRepository;

  function makeEvent(overrides?: Partial<AuditEvent>): AuditEvent {
    return {
      id: randomUUID(),
      action: 'promoted',
      memoryId: randomUUID(),
      tenantId: 'team-alpha',
      actor: { type: 'human', id: 'user-1', name: 'Test User' },
      reason: 'Passed all governance rules',
      details: {},
      timestamp: NOW,
      ...overrides,
    };
  }

  beforeEach(async () => {
    db = createTestDatabase();
    auditRepo = new AuditRepository(db);
    app = buildApp({ db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('requires tenantId — returns 400 without it (no cross-tenant dump)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('tenantId');
  });

  it('returns 400 for a bare memoryId query (must be tenant-scoped)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/audit?memoryId=${randomUUID()}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a bare action query (must be tenant-scoped)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit?action=promoted' });
    expect(res.statusCode).toBe(400);
  });

  it('returns empty array for a tenant with no events', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit?tenantId=nobody' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns events filtered by tenantId', async () => {
    auditRepo.insert(makeEvent({ tenantId: 'team-alpha', action: 'promoted' }));
    auditRepo.insert(makeEvent({ tenantId: 'team-beta', action: 'archived' }));

    const res = await app.inject({ method: 'GET', url: '/api/audit?tenantId=team-alpha' });
    expect(res.statusCode).toBe(200);
    const events = res.json<Array<{ tenantId: string }>>();
    expect(events.every((e) => e.tenantId === 'team-alpha')).toBe(true);
    expect(events.length).toBe(1);
  });

  it('memoryId narrows WITHIN the tenant', async () => {
    const memoryId = randomUUID();
    auditRepo.insert(makeEvent({ memoryId, tenantId: 'team-alpha', action: 'promoted' }));
    auditRepo.insert(makeEvent({ memoryId, tenantId: 'team-alpha', action: 'demoted' }));
    auditRepo.insert(
      makeEvent({ memoryId: randomUUID(), tenantId: 'team-alpha', action: 'archived' }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/audit?tenantId=team-alpha&memoryId=${memoryId}`,
    });
    expect(res.statusCode).toBe(200);
    const events = res.json<Array<{ memoryId: string }>>();
    expect(events.every((e) => e.memoryId === memoryId)).toBe(true);
    expect(events.length).toBe(2);
  });

  it('action narrows WITHIN the tenant', async () => {
    auditRepo.insert(makeEvent({ tenantId: 'team-alpha', action: 'promoted' }));
    auditRepo.insert(makeEvent({ tenantId: 'team-alpha', action: 'archived' }));
    auditRepo.insert(
      makeEvent({ tenantId: 'team-alpha', action: 'promoted', memoryId: randomUUID() }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/audit?tenantId=team-alpha&action=promoted',
    });
    expect(res.statusCode).toBe(200);
    const events = res.json<Array<{ action: string }>>();
    expect(events.every((e) => e.action === 'promoted')).toBe(true);
    expect(events.length).toBe(2);
  });

  it('SECURITY: a memoryId owned by another tenant is NOT leaked', async () => {
    const memoryId = randomUUID();
    // Same memoryId exists under team-other; caller is scoped to team-alpha.
    auditRepo.insert(makeEvent({ memoryId, tenantId: 'team-other', action: 'archived' }));

    const res = await app.inject({
      method: 'GET',
      url: `/api/audit?tenantId=team-alpha&memoryId=${memoryId}`,
    });
    expect(res.statusCode).toBe(200);
    // The cross-tenant row must NOT come back — this is the leak tr08.21 closes.
    expect(res.json<unknown[]>()).toEqual([]);
  });

  it('SECURITY: an action query does not leak other tenants rows', async () => {
    auditRepo.insert(makeEvent({ tenantId: 'team-alpha', action: 'promoted' }));
    auditRepo.insert(makeEvent({ tenantId: 'team-other', action: 'promoted' }));

    const res = await app.inject({
      method: 'GET',
      url: '/api/audit?tenantId=team-alpha&action=promoted',
    });
    const events = res.json<Array<{ tenantId: string }>>();
    expect(events.every((e) => e.tenantId === 'team-alpha')).toBe(true);
    expect(events.length).toBe(1);
  });
});
