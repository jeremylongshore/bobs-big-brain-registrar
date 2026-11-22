import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase, MemoryRepository } from '@qmd-team-intent-kb/store';
import type { SearchScope } from '@qmd-team-intent-kb/schema';
import { buildApp } from '../app.js';
import type { QmdCiteHit, QmdQueryPort } from '../services/search-service.js';
import { makeMemory } from './fixtures.js';

/**
 * A controllable fake qmd port. Records the (query, scope) it was asked for so
 * tests can assert the scope tier was passed through, and returns a fixed
 * cited result set.
 */
class FakeQmd implements QmdQueryPort {
  lastQuery?: string;
  lastScope?: SearchScope;
  lastTenantId?: string;
  tenantIdSeen = false;
  constructor(
    private readonly hits: QmdCiteHit[],
    private readonly fail = false,
  ) {}
  query(
    queryText: string,
    scope?: SearchScope,
    tenantId?: string,
  ): Promise<{ ok: true; value: QmdCiteHit[] } | { ok: false; error: unknown }> {
    this.lastQuery = queryText;
    this.lastScope = scope;
    this.lastTenantId = tenantId;
    this.tenantIdSeen = true;
    if (this.fail) {
      return Promise.resolve({ ok: false, error: { code: 'not_available' } });
    }
    return Promise.resolve({ ok: true, value: this.hits });
  }
}

function hit(file: string, score: number, snippet = 'snip', collection = 'kb-curated'): QmdCiteHit {
  return { file, score, snippet, collection };
}

describe('POST /api/search — qmd cited path', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  beforeEach(() => {
    db = createTestDatabase();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });
  function seed(title: string, score: number, tenantId = 'team-alpha') {
    const memory = makeMemory({
      title,
      tenantId,
      category: 'troubleshooting',
      updatedAt: new Date().toISOString(),
      content: `Current ${title}`,
    });
    new MemoryRepository(db).insert(memory);
    return {
      memory,
      hit: hit(`qmd://kb-guides/${memory.id}.md`, score, 'stale index text', 'kb-guides'),
    };
  }
  it('returns current content with a governed citation', async () => {
    const row = seed('Caddy block', 0.9);
    app = buildApp({ db, qmdAdapter: new FakeQmd([row.hit]) });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'caddy' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits[0]).toMatchObject({
      citation: row.hit.file,
      collection: 'kb-guides',
      memoryId: row.memory.id,
      snippet: row.memory.content,
    });
  });
  it('uses the current stored title rather than a filename-derived title', async () => {
    const row = seed('Current license decision', 1);
    app = buildApp({ db, qmdAdapter: new FakeQmd([row.hit]) });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'license' },
    });
    expect(res.json().hits[0].title).toBe(row.memory.title);
  });
  it('passes the requested scope through to qmd', async () => {
    const qmd = new FakeQmd([]);
    app = buildApp({ db, qmdAdapter: qmd });
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/search', payload: { query: 'x', scope: 'all' } });
    expect(qmd.lastScope).toBe('all');
    expect(qmd.lastQuery).toBe('x');
  });
  it('propagates tenantId to qmd', async () => {
    const qmd = new FakeQmd([]);
    app = buildApp({ db, qmdAdapter: qmd });
    await app.ready();
    await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'x', tenantId: 'team-alpha' },
    });
    expect(qmd.tenantIdSeen).toBe(true);
    expect(qmd.lastTenantId).toBe('team-alpha');
  });
  it('paginates authorized current results', async () => {
    const rows = [seed('one', 0.9), seed('two', 0.8), seed('three', 0.7)];
    app = buildApp({ db, qmdAdapter: new FakeQmd(rows.map((r) => r.hit)) });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'x', pagination: { page: 1, pageSize: 2 } },
    });
    expect(res.json().hits).toHaveLength(2);
    expect(res.json().totalCount).toBe(3);
    expect(res.json().hasMore).toBe(true);
  });
  it('degrades to empty results when qmd fails', async () => {
    app = buildApp({ db, qmdAdapter: new FakeQmd([], true) });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/search', payload: { query: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits).toEqual([]);
    expect(res.json().totalCount).toBe(0);
  });
  it('normalizes scores while preserving authorized qmd ordering', async () => {
    const rows = [seed('one', 8), seed('two', 4)];
    app = buildApp({ db, qmdAdapter: new FakeQmd(rows.map((r) => r.hit)) });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/search', payload: { query: 'x' } });
    expect(res.json().hits[0].score).toBeCloseTo(1, 3);
    expect(res.json().hits[1].score).toBeCloseTo(0.5, 3);
  });
});

// ─── R1: freshness + category rerank on the qmd path ─────────────────────────
// (retrieval epic qmd-team-intent-kb-vps.1)

describe('POST /api/search — qmd path freshness/category rerank', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  const STALE_ID = '11111111-1111-4111-8111-111111111111';
  const FRESH_ID = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('reranks a fresh decision above a stale reference with equal qmd scores', async () => {
    const repo = new MemoryRepository(db);
    const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    repo.insert(
      makeMemory({
        id: STALE_ID,
        title: 'Old reference',
        category: 'reference',
        updatedAt: yearAgo,
        content: 'stale reference content',
      }),
    );
    repo.insert(
      makeMemory({
        id: FRESH_ID,
        title: 'Fresh decision',
        category: 'decision',
        updatedAt: new Date().toISOString(),
        content: 'fresh decision content',
      }),
    );

    // qmd returns the stale memory FIRST with an identical raw score.
    const qmd = new FakeQmd([
      hit(`qmd://kb-guides/${STALE_ID}.md`, 5),
      hit(`qmd://kb-decisions/${FRESH_ID}.md`, 5, 'snip', 'kb-decisions'),
    ]);
    app = buildApp({ db, qmdAdapter: qmd });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'x', scope: 'curated' },
    });
    const body = res.json();
    expect(body.hits[0].citation).toBe(`qmd://kb-decisions/${FRESH_ID}.md`);
    expect(body.hits[0].score).toBeGreaterThan(body.hits[1].score);
    // Resolved hits are enriched with the governed row's identity + category.
    expect(body.hits[0].memoryId).toBe(FRESH_ID);
    expect(body.hits[0].category).toBe('decision');
    // Citations remain the anchor on every hit.
    for (const h of body.hits) expect(h.citation).toMatch(/^qmd:\/\//);
  });

  describe('rerank policy wiring (lifecycle + historical-record demotion)', () => {
    const AAR_ID = '33333333-3333-4333-8333-333333333333';
    const DEPRECATED_ID = '44444444-4444-4444-8444-444444444444';

    function seed(): void {
      const repo = new MemoryRepository(db);
      const now = new Date().toISOString();
      repo.insert(
        makeMemory({
          id: AAR_ID,
          title: 'GCP exodus AAR',
          category: 'decision',
          updatedAt: now,
          content: 'aar content',
        }),
      );
      repo.insert(
        makeMemory({
          id: FRESH_ID,
          title: 'GCP fully exited, all hosting on the VPS',
          category: 'decision',
          updatedAt: now,
          content: 'current decision',
        }),
      );
      repo.insert(
        makeMemory({
          id: DEPRECATED_ID,
          title: 'Old GCP hosting guide',
          category: 'decision',
          lifecycle: 'deprecated',
          updatedAt: now,
          content: 'deprecated guide',
        }),
      );
    }

    async function order(query: string): Promise<string[]> {
      // qmd lists the AAR and the deprecated memory first with equal raw scores.
      const qmd = new FakeQmd([
        hit(`qmd://kb-curated/${AAR_ID}.md`, 5),
        hit(`qmd://kb-curated/${DEPRECATED_ID}.md`, 5),
        hit(`qmd://kb-curated/${FRESH_ID}.md`, 5),
      ]);
      app = buildApp({ db, qmdAdapter: qmd });
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/api/search',
        payload: { query, scope: 'all' },
      });
      return res.json().hits.map((h: { memoryId: string }) => h.memoryId);
    }

    it('ranks the current decision above the historical AAR and the deprecated memory', async () => {
      seed();
      const ids = await order('deploy to production');
      expect(ids[0]).toBe(FRESH_ID);
      expect(ids.indexOf(DEPRECATED_ID)).toBeGreaterThan(ids.indexOf(FRESH_ID));
    });

    it('keeps the AAR on top-tier when the query asks for history', async () => {
      seed();
      const ids = await order('gcp exodus AAR');
      // historical demotion bypassed: AAR keeps its qmd-order lead over the decision
      expect(ids.indexOf(AAR_ID)).toBeLessThan(ids.indexOf(FRESH_ID));
      // lifecycle demotion is NOT bypassed
      expect(ids[ids.length - 1]).toBe(DEPRECATED_ID);
    });
  });

  it('withholds unresolvable citations', async () => {
    const qmd = new FakeQmd([
      hit('qmd://kb-curated/not-a-row.md', 0.9),
      hit('qmd://kb-curated/also-gone.md', 0.6),
    ]);
    app = buildApp({ db, qmdAdapter: qmd });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'x', scope: 'curated' },
    });
    const body = res.json();
    expect(body.hits).toEqual([]);
    expect(body.totalCount).toBe(0);
  });
});
