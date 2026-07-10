import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { createTestDatabase } from '../database.js';
import { MemoryRepository } from '../repositories/memory-repository.js';
import { makeMemory } from './fixtures.js';

/**
 * B1 (bead compile-then-govern-jfv.2.1) — tenant-scoped dedup lookups. A sweep
 * must never treat another tenant's memory as a duplicate.
 */
describe('MemoryRepository — tenant-scoped dedup (B1)', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('findByContentHashAndTenant only matches within the tenant', () => {
    const content = 'shared body of text that both tenants happen to hold';
    const hash = computeContentHash(content);
    repo.insert(makeMemory({ tenantId: 'team-a', content }));

    // Same content, DIFFERENT tenant → not a duplicate for team-b.
    expect(repo.findByContentHashAndTenant(hash, 'team-a')?.tenantId).toBe('team-a');
    expect(repo.findByContentHashAndTenant(hash, 'team-b')).toBeNull();
    // The un-scoped lookup still finds it globally (legacy behavior preserved).
    expect(repo.findByContentHash(hash)).not.toBeNull();
  });

  it('getContentHashesByTenant returns only that tenant hashes', () => {
    repo.insert(makeMemory({ tenantId: 'team-a', content: 'aaa content one' }));
    repo.insert(makeMemory({ tenantId: 'team-a', content: 'aaa content two' }));
    repo.insert(makeMemory({ tenantId: 'team-b', content: 'bbb content one' }));

    expect(repo.getContentHashesByTenant('team-a')).toHaveLength(2);
    expect(repo.getContentHashesByTenant('team-b')).toHaveLength(1);
    expect(repo.getAllContentHashes()).toHaveLength(3);
  });
});
