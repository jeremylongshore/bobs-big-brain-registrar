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

  it('returns qmd:// citations when the qmd adapter is wired', async () => {
    const qmd = new FakeQmd([
      hit('qmd://kb-curated/caddy-block.md', 0.9, 'The Caddy block reverse-proxies …'),
      hit('qmd://kb-curated/system-map.md', 0.6, 'System map overview …'),
    ]);
    app = buildApp({ db, qmdAdapter: qmd });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'caddy', scope: 'curated' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCount).toBe(2);
    expect(body.hits[0].citation).toBe('qmd://kb-curated/caddy-block.md');
    expect(body.hits[0].citation.startsWith('qmd://')).toBe(true);
    expect(body.hits[0].collection).toBe('kb-curated');
    // every hit is anchored to a verifiable citation — the wedge
    for (const h of body.hits) {
      expect(h.citation).toMatch(/^qmd:\/\//);
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
  });

  it('derives a human title from the citation filename', async () => {
    const qmd = new FakeQmd([hit('qmd://kb-decisions/use-apache-2.md', 1)]);
    app = buildApp({ db, qmdAdapter: qmd });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'license', scope: 'curated' },
    });
    expect(res.json().hits[0].title).toBe('use apache 2');
  });

  it('passes the requested scope through to qmd (tier split)', async () => {
    const qmd = new FakeQmd([hit('qmd://kb-curated/a.md', 1)]);
    app = buildApp({ db, qmdAdapter: qmd });
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'x', scope: 'all' },
    });
    expect(qmd.lastScope).toBe('all');
    expect(qmd.lastQuery).toBe('x');
  });

  // ---- tenant isolation on the qmd path (EPIC 0, compile-then-govern-c5k) ---

  it('propagates tenantId to qmd so the cited path is tenant-scoped', async () => {
    const qmd = new FakeQmd([hit('qmd://kb-curated/a.md', 1)]);
    app = buildApp({ db, qmdAdapter: qmd });
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'x', scope: 'curated', tenantId: 'team-alpha' },
    });
    // Before the fix the qmd path dropped tenantId entirely (leaking every
    // tenant's governed memories). The argument must now reach qmd.
    expect(qmd.tenantIdSeen).toBe(true);
    expect(qmd.lastTenantId).toBe('team-alpha');
  });

  it('paginates the qmd result set', async () => {
    const qmd = new FakeQmd([
      hit('qmd://kb-curated/a.md', 0.9),
      hit('qmd://kb-curated/b.md', 0.8),
      hit('qmd://kb-curated/c.md', 0.7),
    ]);
    app = buildApp({ db, qmdAdapter: qmd });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'x', scope: 'curated', pagination: { page: 1, pageSize: 2 } },
    });
    const body = res.json();
    expect(body.hits).toHaveLength(2);
    expect(body.totalCount).toBe(3);
    expect(body.hasMore).toBe(true);
  });

  it('degrades to empty results (not 500) when qmd fails', async () => {
    const qmd = new FakeQmd([], true);
    app = buildApp({ db, qmdAdapter: qmd });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'x', scope: 'curated' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCount).toBe(0);
    expect(res.json().hits).toEqual([]);
  });

  it('normalises scores to [0,1] preserving qmd ordering when top score > 1', async () => {
    const qmd = new FakeQmd([hit('qmd://kb-curated/a.md', 8), hit('qmd://kb-curated/b.md', 4)]);
    app = buildApp({ db, qmdAdapter: qmd });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'x', scope: 'curated' },
    });
    const body = res.json();
    expect(body.hits[0].score).toBe(1); // 8/8
    expect(body.hits[1].score).toBe(0.5); // 4/8
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

  it('leaves unresolvable citations in qmd order without enrichment', async () => {
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
    expect(body.hits[0].citation).toBe('qmd://kb-curated/not-a-row.md');
    expect(body.hits[0].memoryId).toBeUndefined();
    expect(body.hits[0].category).toBeUndefined();
    expect(body.hits[1].score).toBeCloseTo(0.6 / 0.9, 3);
  });
});
