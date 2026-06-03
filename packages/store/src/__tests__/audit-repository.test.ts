import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { AuditRepository } from '../repositories/audit-repository.js';
import { makeAuditEvent } from './fixtures.js';

describe('AuditRepository', () => {
  let db: Database.Database;
  let repo: AuditRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new AuditRepository(db);
  });

  it('inserts an event and retrieves it by memoryId', () => {
    const memoryId = randomUUID();
    const event = makeAuditEvent({ memoryId });
    repo.insert(event);
    const found = repo.findByMemory(memoryId);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(event.id);
    expect(found[0]?.action).toBe('promoted');
    expect(found[0]?.memoryId).toBe(memoryId);
  });

  it('findByTenant returns all events for the tenant', () => {
    const tenantId = 'team-alpha';
    const e1 = makeAuditEvent({ tenantId, memoryId: randomUUID() });
    const e2 = makeAuditEvent({ tenantId, memoryId: randomUUID(), action: 'archived' });
    const e3 = makeAuditEvent({ tenantId: 'team-beta', memoryId: randomUUID() });
    repo.insert(e1);
    repo.insert(e2);
    repo.insert(e3);

    const results = repo.findByTenant(tenantId);
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.tenantId === tenantId)).toBe(true);
  });

  it('findByAction returns only events with the specified action', () => {
    const e1 = makeAuditEvent({ action: 'promoted', memoryId: randomUUID() });
    const e2 = makeAuditEvent({ action: 'archived', memoryId: randomUUID() });
    const e3 = makeAuditEvent({ action: 'promoted', memoryId: randomUUID() });
    repo.insert(e1);
    repo.insert(e2);
    repo.insert(e3);

    const promoted = repo.findByAction('promoted');
    expect(promoted).toHaveLength(2);
    expect(promoted.every((e) => e.action === 'promoted')).toBe(true);

    const archived = repo.findByAction('archived');
    expect(archived).toHaveLength(1);
    expect(archived[0]?.action).toBe('archived');
  });

  it('multiple events for the same memory are all returned in order', () => {
    const memoryId = randomUUID();
    const e1 = makeAuditEvent({
      memoryId,
      action: 'promoted',
      timestamp: '2026-01-01T10:00:00.000Z',
    });
    const e2 = makeAuditEvent({
      memoryId,
      action: 'archived',
      timestamp: '2026-01-02T10:00:00.000Z',
    });
    repo.insert(e1);
    repo.insert(e2);

    const found = repo.findByMemory(memoryId);
    expect(found).toHaveLength(2);
    expect(found[0]?.action).toBe('promoted');
    expect(found[1]?.action).toBe('archived');
  });
});

describe('AuditRepository — aggregation queries', () => {
  let db: Database.Database;
  let repo: AuditRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new AuditRepository(db);
  });

  // countByAction
  it('countByAction returns empty record when no events exist', () => {
    expect(repo.countByAction()).toEqual({});
  });

  it('countByAction returns correct counts per action type', () => {
    repo.insert(makeAuditEvent({ action: 'promoted', memoryId: randomUUID() }));
    repo.insert(makeAuditEvent({ action: 'promoted', memoryId: randomUUID() }));
    repo.insert(makeAuditEvent({ action: 'archived', memoryId: randomUUID() }));
    const counts = repo.countByAction();
    expect(counts['promoted']).toBe(2);
    expect(counts['archived']).toBe(1);
    expect(counts['deprecated']).toBeUndefined();
  });

  // findInRange
  it('findInRange returns events within the inclusive range', () => {
    repo.insert(makeAuditEvent({ memoryId: randomUUID(), timestamp: '2026-01-01T00:00:00.000Z' }));
    repo.insert(makeAuditEvent({ memoryId: randomUUID(), timestamp: '2026-02-15T00:00:00.000Z' }));
    repo.insert(makeAuditEvent({ memoryId: randomUUID(), timestamp: '2026-03-01T00:00:00.000Z' }));
    const results = repo.findInRange('2026-01-15T00:00:00.000Z', '2026-02-28T00:00:00.000Z');
    expect(results).toHaveLength(1);
    expect(results[0]?.timestamp).toBe('2026-02-15T00:00:00.000Z');
  });

  it('findInRange returns events at the exact boundary timestamps', () => {
    const start = '2026-01-01T00:00:00.000Z';
    const end = '2026-12-31T23:59:59.999Z';
    repo.insert(makeAuditEvent({ memoryId: randomUUID(), timestamp: start }));
    repo.insert(makeAuditEvent({ memoryId: randomUUID(), timestamp: end }));
    const results = repo.findInRange(start, end);
    expect(results).toHaveLength(2);
  });

  // countByTenantAndAction
  it('countByTenantAndAction returns counts scoped to the given tenant', () => {
    repo.insert(
      makeAuditEvent({ tenantId: 'team-alpha', action: 'promoted', memoryId: randomUUID() }),
    );
    repo.insert(
      makeAuditEvent({ tenantId: 'team-alpha', action: 'archived', memoryId: randomUUID() }),
    );
    repo.insert(
      makeAuditEvent({ tenantId: 'team-beta', action: 'promoted', memoryId: randomUUID() }),
    );
    const alphaCounts = repo.countByTenantAndAction('team-alpha');
    expect(alphaCounts['promoted']).toBe(1);
    expect(alphaCounts['archived']).toBe(1);
    const betaCounts = repo.countByTenantAndAction('team-beta');
    expect(betaCounts['promoted']).toBe(1);
    expect(betaCounts['archived']).toBeUndefined();
  });

  it('countByTenantAndAction returns empty record for unknown tenant', () => {
    repo.insert(makeAuditEvent({ tenantId: 'team-alpha', memoryId: randomUUID() }));
    expect(repo.countByTenantAndAction('team-unknown')).toEqual({});
  });

  // Tenant-scoped lookups (bead tr08.21) — the safe path for single-tenant callers.

  it('findByMemoryAndTenant returns only the matching tenant rows for a memory', () => {
    const memoryId = randomUUID();
    repo.insert(makeAuditEvent({ memoryId, tenantId: 'team-alpha' }));
    repo.insert(makeAuditEvent({ memoryId, tenantId: 'team-other' }));

    const alpha = repo.findByMemoryAndTenant(memoryId, 'team-alpha');
    expect(alpha).toHaveLength(1);
    expect(alpha[0]?.tenantId).toBe('team-alpha');
  });

  it('findByMemoryAndTenant returns [] when the memory belongs to another tenant', () => {
    const memoryId = randomUUID();
    repo.insert(makeAuditEvent({ memoryId, tenantId: 'team-other' }));
    expect(repo.findByMemoryAndTenant(memoryId, 'team-alpha')).toEqual([]);
  });

  it('findByTenantAndAction scopes an action query to one tenant', () => {
    repo.insert(
      makeAuditEvent({ tenantId: 'team-alpha', action: 'promoted', memoryId: randomUUID() }),
    );
    repo.insert(
      makeAuditEvent({ tenantId: 'team-other', action: 'promoted', memoryId: randomUUID() }),
    );

    const alpha = repo.findByTenantAndAction('team-alpha', 'promoted');
    expect(alpha).toHaveLength(1);
    expect(alpha[0]?.tenantId).toBe('team-alpha');
  });
});
