import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase, MemoryRepository } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';
import { makeMemory } from './fixtures.js';

describe('POST /api/search', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let memoryRepo: MemoryRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    app = buildApp({ db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns matching memories by title', async () => {
    const memory = makeMemory({ title: 'Database indexing strategy' });
    memoryRepo.insert(memory);

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'indexing', scope: 'curated' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCount).toBe(1);
    expect(body.hits[0].memoryId).toBe(memory.id);
  });

  it('returns matching memories by content', async () => {
    const memory = makeMemory({
      title: 'Something unrelated',
      content: 'Always use parameterized queries to prevent SQL injection attacks',
      contentHash: 'c'.repeat(64),
    });
    memoryRepo.insert(memory);

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'parameterized', scope: 'curated' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCount).toBe(1);
  });

  it('returns empty results for non-matching query', async () => {
    const memory = makeMemory();
    memoryRepo.insert(memory);

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'zzzznonexistent', scope: 'curated' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCount).toBe(0);
    expect(res.json().hits).toEqual([]);
    expect(res.json().hasMore).toBe(false);
  });

  it('returns 400 for invalid search query body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { scope: 'curated' }, // missing query field
    });
    expect(res.statusCode).toBe(400);
  });

  it('respects pagination', async () => {
    // Insert 3 memories that all match
    for (let i = 0; i < 3; i++) {
      memoryRepo.insert(
        makeMemory({
          title: `Test pattern number ${i}`,
          content: `Use the searchable pattern in your code for item ${i}`,
          contentHash: `${String.fromCharCode(97 + i)}`.repeat(64),
        }),
      );
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: {
        query: 'pattern',
        scope: 'curated',
        pagination: { page: 1, pageSize: 2 },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hits).toHaveLength(2);
    expect(body.totalCount).toBe(3);
    expect(body.hasMore).toBe(true);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(2);
  });

  it('filters by tenantId', async () => {
    memoryRepo.insert(makeMemory({ tenantId: 'team-alpha', title: 'Alpha pattern' }));
    memoryRepo.insert(
      makeMemory({
        tenantId: 'team-beta',
        title: 'Beta pattern',
        contentHash: 'b'.repeat(64),
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'pattern', scope: 'curated', tenantId: 'team-alpha' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCount).toBe(1);
  });

  it('title matches score higher than content-only matches', async () => {
    memoryRepo.insert(
      makeMemory({
        title: 'Caching strategy',
        content: 'How to implement caching',
      }),
    );
    memoryRepo.insert(
      makeMemory({
        title: 'Unrelated title',
        content: 'Consider using a caching layer for performance',
        contentHash: 'b'.repeat(64),
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'caching', scope: 'curated' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hits).toHaveLength(2);
    // First hit should be the title match (higher score)
    expect(body.hits[0].title).toBe('Caching strategy');
  });

  it('search result hits have required fields', async () => {
    memoryRepo.insert(makeMemory({ title: 'Error handling patterns' }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'Error', scope: 'curated' },
    });
    expect(res.statusCode).toBe(200);
    const hit = res.json().hits[0];
    expect(hit).toHaveProperty('memoryId');
    expect(hit).toHaveProperty('title');
    expect(hit).toHaveProperty('snippet');
    expect(hit).toHaveProperty('score');
    expect(hit).toHaveProperty('category');
    expect(hit).toHaveProperty('matchedAt');
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.score).toBeLessThanOrEqual(1);
  });

  it('excludes confidential and restricted memories from search results (5bm.11)', () => {
    const visible = makeMemory({ title: 'Indexing strategy public', sensitivity: 'internal' });
    const confidential = makeMemory({
      title: 'Indexing strategy secret',
      sensitivity: 'confidential',
      contentHash: 'c'.repeat(64),
    });
    const restricted = makeMemory({
      title: 'Indexing strategy locked',
      sensitivity: 'restricted',
      contentHash: 'd'.repeat(64),
    });
    memoryRepo.insert(visible);
    memoryRepo.insert(confidential);
    memoryRepo.insert(restricted);

    return app
      .inject({
        method: 'POST',
        url: '/api/search',
        payload: { query: 'indexing', scope: 'curated' },
      })
      .then((res) => {
        expect(res.statusCode).toBe(200);
        const body = res.json();
        // Only the internal-sensitivity memory is search-visible.
        expect(body.totalCount).toBe(1);
        const ids = body.hits.map((h: { memoryId: string }) => h.memoryId);
        expect(ids).toContain(visible.id);
        expect(ids).not.toContain(confidential.id);
        expect(ids).not.toContain(restricted.id);
      });
  });
});
