import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { MemoryRepository } from '../repositories/memory-repository.js';
import { makeMemory, HASH_A, HASH_B, NOW } from './fixtures.js';

const LATER = '2026-02-01T12:00:00.000Z';

describe('MemoryRepository', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryRepository(db);
  });

  it('inserts a memory and retrieves it by id', () => {
    const memory = makeMemory();
    repo.insert(memory);
    const found = repo.findById(memory.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(memory.id);
    expect(found?.content).toBe(memory.content);
    expect(found?.lifecycle).toBe('active');
  });

  it('findByTenant returns only memories for the matching tenant', () => {
    const m1 = makeMemory({ tenantId: 'team-alpha' });
    const m2 = makeMemory({ tenantId: 'team-beta', contentHash: HASH_B });
    repo.insert(m1);
    repo.insert(m2);

    const alphaResults = repo.findByTenant('team-alpha');
    expect(alphaResults).toHaveLength(1);
    expect(alphaResults[0]?.tenantId).toBe('team-alpha');

    const betaResults = repo.findByTenant('team-beta');
    expect(betaResults).toHaveLength(1);
    expect(betaResults[0]?.tenantId).toBe('team-beta');
  });

  it('findByContentHash returns the matching memory', () => {
    const memory = makeMemory({ contentHash: HASH_A });
    repo.insert(memory);
    const found = repo.findByContentHash(HASH_A);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(memory.id);
  });

  it('findByLifecycle filters correctly to requested state', () => {
    const active = makeMemory({ lifecycle: 'active' });
    const deprecated = makeMemory({ lifecycle: 'deprecated', contentHash: HASH_B });
    repo.insert(active);
    repo.insert(deprecated);

    const activeResults = repo.findByLifecycle('active');
    expect(activeResults).toHaveLength(1);
    expect(activeResults[0]?.lifecycle).toBe('active');

    const deprecatedResults = repo.findByLifecycle('deprecated');
    expect(deprecatedResults).toHaveLength(1);
    expect(deprecatedResults[0]?.lifecycle).toBe('deprecated');
  });

  it('updateLifecycle changes the lifecycle state and returns true', () => {
    const memory = makeMemory({ lifecycle: 'active' });
    repo.insert(memory);
    const updated = repo.updateLifecycle(memory.id, 'deprecated', LATER);
    expect(updated).toBe(true);
    const found = repo.findById(memory.id);
    expect(found?.lifecycle).toBe('deprecated');
    expect(found?.updatedAt).toBe(LATER);
  });

  it('update performs a full record update and returns true', () => {
    const memory = makeMemory();
    repo.insert(memory);
    const updatedMemory = { ...memory, title: 'Updated title', version: 2, updatedAt: LATER };
    const result = repo.update(updatedMemory);
    expect(result).toBe(true);
    const found = repo.findById(memory.id);
    expect(found?.title).toBe('Updated title');
    expect(found?.version).toBe(2);
    expect(found?.updatedAt).toBe(LATER);
  });

  it('count returns the correct number of memories', () => {
    expect(repo.count()).toBe(0);
    repo.insert(makeMemory({ contentHash: HASH_A }));
    expect(repo.count()).toBe(1);
    repo.insert(makeMemory({ contentHash: HASH_B }));
    expect(repo.count()).toBe(2);
  });

  it('getAllContentHashes returns all stored hashes', () => {
    repo.insert(makeMemory({ contentHash: HASH_A }));
    repo.insert(makeMemory({ contentHash: HASH_B }));
    const hashes = repo.getAllContentHashes();
    expect(hashes).toHaveLength(2);
    expect(hashes).toContain(HASH_A);
    expect(hashes).toContain(HASH_B);
  });

  it('returns null for a non-existent id', () => {
    expect(repo.findById(randomUUID())).toBeNull();
  });

  it('multiple memories with different lifecycles are all retrievable', () => {
    const states = ['active', 'deprecated', 'archived'] as const;
    const hashes = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)] as const;
    states.forEach((lifecycle, i) => {
      repo.insert(makeMemory({ lifecycle, contentHash: hashes[i] }));
    });
    expect(repo.count()).toBe(3);
    expect(repo.findByLifecycle('active')).toHaveLength(1);
    expect(repo.findByLifecycle('deprecated')).toHaveLength(1);
    expect(repo.findByLifecycle('archived')).toHaveLength(1);
    expect(repo.findByLifecycle('superseded')).toHaveLength(0);
  });

  it('preserves policyEvaluations and supersession on round-trip', () => {
    const supersessionLink = {
      supersededBy: randomUUID(),
      reason: 'Replaced by newer version',
      linkedAt: NOW,
    };
    const policyEvaluations = [
      {
        policyId: randomUUID(),
        ruleId: 'rule-1',
        result: 'pass' as const,
        reason: 'Passed check',
        evaluatedAt: NOW,
      },
    ];
    const memory = makeMemory({
      lifecycle: 'superseded',
      supersession: supersessionLink,
      policyEvaluations,
      contentHash: HASH_B,
    });
    repo.insert(memory);
    const found = repo.findById(memory.id);
    expect(found?.supersession?.reason).toBe('Replaced by newer version');
    expect(found?.policyEvaluations).toHaveLength(1);
    expect(found?.policyEvaluations[0]?.result).toBe('pass');
  });
});

describe('MemoryRepository — aggregation queries', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryRepository(db);
  });

  // countByLifecycle
  it('countByLifecycle returns empty record when no memories exist', () => {
    expect(repo.countByLifecycle()).toEqual({});
  });

  it('countByLifecycle returns correct counts for each state', () => {
    repo.insert(
      makeMemory({
        lifecycle: 'active',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        lifecycle: 'active',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        lifecycle: 'deprecated',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const counts = repo.countByLifecycle();
    expect(counts['active']).toBe(2);
    expect(counts['deprecated']).toBe(1);
    expect(counts['archived']).toBeUndefined();
  });

  // countByCategory
  it('countByCategory returns correct counts per category', () => {
    repo.insert(
      makeMemory({
        category: 'pattern',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        category: 'pattern',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        category: 'convention',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const counts = repo.countByCategory();
    expect(counts['pattern']).toBe(2);
    expect(counts['convention']).toBe(1);
  });

  // countByTenant
  it('countByTenant returns correct counts per tenant', () => {
    repo.insert(
      makeMemory({
        tenantId: 'team-alpha',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        tenantId: 'team-beta',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        tenantId: 'team-beta',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const counts = repo.countByTenant();
    expect(counts['team-alpha']).toBe(1);
    expect(counts['team-beta']).toBe(2);
  });

  // findStale
  it('findStale returns active memories older than the threshold', () => {
    const OLD = '2025-06-01T00:00:00.000Z';
    const RECENT = '2026-03-01T00:00:00.000Z';
    const THRESHOLD = '2026-01-01T00:00:00.000Z';
    repo.insert(
      makeMemory({
        lifecycle: 'active',
        updatedAt: OLD,
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        lifecycle: 'active',
        updatedAt: RECENT,
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const stale = repo.findStale(THRESHOLD);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.updatedAt).toBe(OLD);
  });

  it('findStale ignores non-active memories even when old', () => {
    const OLD = '2025-06-01T00:00:00.000Z';
    const THRESHOLD = '2026-01-01T00:00:00.000Z';
    repo.insert(
      makeMemory({
        lifecycle: 'deprecated',
        updatedAt: OLD,
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const stale = repo.findStale(THRESHOLD);
    expect(stale).toHaveLength(0);
  });

  // findByTenantAndLifecycle
  it('findByTenantAndLifecycle filters on both tenant and lifecycle', () => {
    repo.insert(
      makeMemory({
        tenantId: 'team-alpha',
        lifecycle: 'active',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        tenantId: 'team-alpha',
        lifecycle: 'deprecated',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        tenantId: 'team-beta',
        lifecycle: 'active',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const results = repo.findByTenantAndLifecycle('team-alpha', 'active');
    expect(results).toHaveLength(1);
    expect(results[0]?.tenantId).toBe('team-alpha');
    expect(results[0]?.lifecycle).toBe('active');
  });

  it('findByTenantAndLifecycle returns empty array when no match', () => {
    repo.insert(
      makeMemory({
        tenantId: 'team-alpha',
        lifecycle: 'active',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const results = repo.findByTenantAndLifecycle('team-alpha', 'archived');
    expect(results).toHaveLength(0);
  });
});

describe('MemoryRepository — searchByText', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryRepository(db);
  });

  it('returns memories matching title', () => {
    repo.insert(
      makeMemory({
        title: 'API validation pattern',
        content: 'Always validate inputs at the boundary',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    // Insert a second memory with a non-matching title to confirm filtering
    repo.insert(
      makeMemory({
        title: 'Database migration guide',
        content: 'Run migrations before deploying',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const results = repo.searchByText('validation');
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('API validation pattern');
  });

  it('returns memories matching content', () => {
    repo.insert(
      makeMemory({
        title: 'Retry strategy',
        content: 'Use exponential backoff for all transient failures',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const results = repo.searchByText('exponential backoff');
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Retry strategy');
  });

  it('filters by tenantId', () => {
    repo.insert(
      makeMemory({
        tenantId: 'team-alpha',
        title: 'Caching convention',
        content: 'Cache at the service layer only',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        tenantId: 'team-beta',
        title: 'Caching convention',
        content: 'Cache at the service layer only',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const results = repo.searchByText('Cache', 'team-alpha');
    expect(results).toHaveLength(1);
    expect(results[0]?.tenantId).toBe('team-alpha');
  });

  it('filters by categories', () => {
    repo.insert(
      makeMemory({
        category: 'pattern',
        title: 'Request scoping pattern',
        content: 'Scope all requests via middleware',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        category: 'decision',
        title: 'Database decision',
        content: 'Scope decided: use SQLite for local storage',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const patternResults = repo.searchByText('Scope', undefined, ['pattern']);
    expect(patternResults).toHaveLength(1);
    expect(patternResults[0]?.category).toBe('pattern');

    const bothResults = repo.searchByText('Scope', undefined, ['pattern', 'decision']);
    expect(bothResults).toHaveLength(2);
  });

  it('only returns active memories', () => {
    const sharedContent = 'Shared unique observability content xq7';
    repo.insert(
      makeMemory({
        lifecycle: 'active',
        title: 'Observability active',
        content: sharedContent,
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    repo.insert(
      makeMemory({
        lifecycle: 'deprecated',
        title: 'Observability deprecated',
        content: sharedContent,
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const results = repo.searchByText('xq7');
    expect(results).toHaveLength(1);
    expect(results[0]?.lifecycle).toBe('active');
  });

  it('returns empty array for no matches', () => {
    repo.insert(
      makeMemory({
        title: 'Unrelated topic',
        content: 'Nothing relevant here',
        contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      }),
    );
    const results = repo.searchByText('zzznomatchzzz');
    expect(results).toHaveLength(0);
  });
});

describe('MemoryRepository — Zod-on-read malformed row rejection', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new MemoryRepository(db);
  });

  it('throws a descriptive error when policy_evaluations_json contains invalid JSON', () => {
    // Insert a row with malformed policy_evaluations_json to simulate DB corruption
    const id = randomUUID();
    const validAuthor = JSON.stringify({ type: 'ai', id: 'session-1', name: 'Claude' });
    db.prepare(
      `
      INSERT INTO curated_memories (
        id, candidate_id, source, content, title, category,
        trust_level, sensitivity, author_json, tenant_id,
        metadata_json, lifecycle, content_hash,
        policy_evaluations_json, supersession_json,
        promoted_at, promoted_by_json, updated_at, version
      ) VALUES (
        ?, ?, 'claude_session', 'Some content', 'Some title', 'pattern',
        'high', 'internal', ?, 'team-alpha',
        '{}', 'active', ?,
        'NOT_VALID_JSON', NULL,
        ?, ?, ?, 1
      )
    `,
    ).run(id, randomUUID(), validAuthor, HASH_A, NOW, validAuthor, NOW);

    expect(() => repo.findById(id)).toThrowError(
      /curated_memories row id=.+: policy_evaluations_json is not valid JSON/,
    );
  });

  it('throws a descriptive error when lifecycle contains an invalid enum value', () => {
    // Insert a row with an unrecognised lifecycle value to simulate schema drift.
    // The new enum CHECK constraints (5bm.1) would otherwise refuse to plant this
    // drift row on a fresh DB — but the read-side Zod guard still matters for the
    // live CHECK-less DB, so disable CHECK enforcement just to stage the scenario.
    db.pragma('ignore_check_constraints = ON');
    const id = randomUUID();
    const validAuthor = JSON.stringify({ type: 'human', id: 'user-1', name: 'Test User' });
    db.prepare(
      `
      INSERT INTO curated_memories (
        id, candidate_id, source, content, title, category,
        trust_level, sensitivity, author_json, tenant_id,
        metadata_json, lifecycle, content_hash,
        policy_evaluations_json, supersession_json,
        promoted_at, promoted_by_json, updated_at, version
      ) VALUES (
        ?, ?, 'claude_session', 'Some content', 'Some title', 'pattern',
        'high', 'internal', ?, 'team-alpha',
        '{}', 'INVALID_LIFECYCLE', ?,
        '[]', NULL,
        ?, ?, ?, 1
      )
    `,
    ).run(id, randomUUID(), validAuthor, HASH_B, NOW, validAuthor, NOW);

    expect(() => repo.findById(id)).toThrowError(
      /curated_memories row id=.+ failed domain validation/,
    );
  });
});
