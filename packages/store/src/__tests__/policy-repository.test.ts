import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { PolicyRepository } from '../repositories/policy-repository.js';
import { makePolicy } from './fixtures.js';

const LATER = '2026-02-01T12:00:00.000Z';

describe('PolicyRepository', () => {
  let db: Database.Database;
  let repo: PolicyRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new PolicyRepository(db);
  });

  it('inserts a policy and retrieves it by id', () => {
    const policy = makePolicy();
    repo.insert(policy);
    const found = repo.findById(policy.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(policy.id);
    expect(found?.name).toBe(policy.name);
    expect(found?.enabled).toBe(true);
    expect(found?.rules).toHaveLength(1);
  });

  it('findByTenant returns policies for the matching tenant only', () => {
    const p1 = makePolicy({ tenantId: 'team-alpha' });
    const p2 = makePolicy({ tenantId: 'team-beta' });
    repo.insert(p1);
    repo.insert(p2);

    const alphaResults = repo.findByTenant('team-alpha');
    expect(alphaResults).toHaveLength(1);
    expect(alphaResults[0]?.tenantId).toBe('team-alpha');
  });

  it('list returns every policy across all tenants (5bm.10)', () => {
    expect(repo.list()).toEqual([]);
    repo.insert(makePolicy({ tenantId: 'team-alpha' }));
    repo.insert(makePolicy({ tenantId: 'team-beta' }));
    const all = repo.list();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.tenantId).sort()).toEqual(['team-alpha', 'team-beta']);
  });

  it('update modifies an existing policy and returns true', () => {
    const policy = makePolicy();
    repo.insert(policy);
    const updated = { ...policy, name: 'Updated Policy', version: 2, updatedAt: LATER };
    const result = repo.update(updated);
    expect(result).toBe(true);
    const found = repo.findById(policy.id);
    expect(found?.name).toBe('Updated Policy');
    expect(found?.version).toBe(2);
  });

  it('update returns false for a non-existent id', () => {
    const policy = makePolicy();
    const result = repo.update(policy);
    expect(result).toBe(false);
  });

  it('delete removes the policy and returns true', () => {
    const policy = makePolicy();
    repo.insert(policy);
    const deleted = repo.delete(policy.id);
    expect(deleted).toBe(true);
    expect(repo.findById(policy.id)).toBeNull();
  });

  it('delete returns false for a non-existent id', () => {
    expect(repo.delete(randomUUID())).toBe(false);
  });

  it('findByTenant returns multiple policies for the same tenant', () => {
    const p1 = makePolicy({ tenantId: 'team-alpha', name: 'Policy One' });
    const p2 = makePolicy({ tenantId: 'team-alpha', name: 'Policy Two' });
    const p3 = makePolicy({ tenantId: 'team-beta', name: 'Other Policy' });
    repo.insert(p1);
    repo.insert(p2);
    repo.insert(p3);

    const results = repo.findByTenant('team-alpha');
    expect(results).toHaveLength(2);
    const names = results.map((p) => p.name);
    expect(names).toContain('Policy One');
    expect(names).toContain('Policy Two');
  });
});
