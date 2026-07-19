import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { createTestDatabase } from '../database.js';
import { MemoryRepository } from '../repositories/memory-repository.js';
import { IndexStateRepository } from '../repositories/index-state-repository.js';

const T0 = '2026-07-01T00:00:00.000Z';
const T1 = '2026-07-01T01:00:00.000Z';
const T2 = '2026-07-01T02:00:00.000Z';
/** A "now" 1 hour after T2, in ms. */
const NOW_MS = Date.parse('2026-07-01T03:00:00.000Z');

describe('IndexStateRepository', () => {
  let db: Database.Database;
  let repo: IndexStateRepository;
  let memories: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new IndexStateRepository(db);
    memories = new MemoryRepository(db);
  });

  it('markIndexed stores state and get retrieves it', () => {
    repo.markIndexed('team-alpha', T1);
    const state = repo.get('team-alpha');
    expect(state).not.toBeNull();
    expect(state?.tenantId).toBe('team-alpha');
    expect(state?.lastIndexedAt).toBe(T1);
    expect((state?.updatedAt ?? '').length).toBeGreaterThan(0);
  });

  it('markIndexed upserts — calling again advances lastIndexedAt', () => {
    repo.markIndexed('team-alpha', T1);
    repo.markIndexed('team-alpha', T2);
    expect(repo.get('team-alpha')?.lastIndexedAt).toBe(T2);
  });

  it('get returns null for a tenant that never indexed', () => {
    expect(repo.get('unknown')).toBeNull();
  });

  // ─── stalenessSeconds contract: null = unmeasured, 0 = fresh, >0 = stale ───

  it('is null (unmeasured) when no index_state row exists — even with promotions pending', () => {
    memories.insert(makeMemory({ tenantId: 'team-alpha', promotedAt: T2 }));
    expect(repo.stalenessSeconds('team-alpha', NOW_MS)).toBeNull();
  });

  it('is 0 (fresh) when every promotion is at or before lastIndexedAt', () => {
    memories.insert(makeMemory({ tenantId: 'team-alpha', promotedAt: T0 }));
    repo.markIndexed('team-alpha', T1);
    expect(repo.stalenessSeconds('team-alpha', NOW_MS)).toBe(0);
  });

  it('is 0 (fresh) when the tenant has no memories at all', () => {
    repo.markIndexed('team-alpha', T1);
    expect(repo.stalenessSeconds('team-alpha', NOW_MS)).toBe(0);
  });

  it('reports seconds since the OLDEST un-indexed promotion', () => {
    repo.markIndexed('team-alpha', T0);
    // Two promotions after the last index: T1 (oldest) and T2. Staleness is
    // measured from T1 — worst case, not most recent.
    memories.insert(makeMemory({ tenantId: 'team-alpha', promotedAt: T1 }));
    memories.insert(makeMemory({ tenantId: 'team-alpha', promotedAt: T2 }));
    // NOW_MS is 2h after T1.
    expect(repo.stalenessSeconds('team-alpha', NOW_MS)).toBe(2 * 3600);
  });

  it('goes back to 0 after markIndexed absorbs the pending promotion', () => {
    repo.markIndexed('team-alpha', T0);
    memories.insert(makeMemory({ tenantId: 'team-alpha', promotedAt: T1 }));
    expect(repo.stalenessSeconds('team-alpha', NOW_MS)).toBeGreaterThan(0);
    repo.markIndexed('team-alpha', T2);
    expect(repo.stalenessSeconds('team-alpha', NOW_MS)).toBe(0);
  });

  it('is tenant-scoped — another tenant’s promotions do not bleed in', () => {
    repo.markIndexed('team-alpha', T0);
    memories.insert(makeMemory({ tenantId: 'team-beta', promotedAt: T2 }));
    expect(repo.stalenessSeconds('team-alpha', NOW_MS)).toBe(0);
  });

  // ─── worstStalenessSeconds ─────────────────────────────────────────────────

  it('worstStalenessSeconds is null when no tenant has begun measurement', () => {
    memories.insert(makeMemory({ tenantId: 'team-alpha', promotedAt: T1 }));
    expect(repo.worstStalenessSeconds(NOW_MS)).toBeNull();
  });

  it('worstStalenessSeconds returns the largest per-tenant staleness', () => {
    // alpha: fresh. beta: stale since T1 (2h before NOW_MS).
    repo.markIndexed('team-alpha', T2);
    repo.markIndexed('team-beta', T0);
    memories.insert(makeMemory({ tenantId: 'team-beta', promotedAt: T1 }));
    expect(repo.worstStalenessSeconds(NOW_MS)).toBe(2 * 3600);
  });
});
