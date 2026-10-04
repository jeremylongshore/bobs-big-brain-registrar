import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  CandidateRepository,
  MemoryRepository,
  MemoryLinksRepository,
} from '@qmd-team-intent-kb/store';
import type { CuratedMemory, SearchScope } from '@qmd-team-intent-kb/schema';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { buildApp } from '../app.js';
import { readerRoleOf } from '../middleware/api-key-auth.js';
import { InMemoryTokenRegistry, loadTokenRecords } from '../auth/token-registry.js';
import { SearchService } from '../services/search-service.js';
import type { QmdCiteHit, QmdQueryPort } from '../services/search-service.js';
import { makeCandidate, makeMemory, makeTransitionBody } from './fixtures.js';

/**
 * Claim-level audience, end to end on a real SQLite store (Epic K bead K2).
 *
 * A memory may declare `metadata.audience`: `tenant` (default — everyone in the
 * tenant), `admins`, or `owner`. Every read path must refuse to show a memory to
 * a caller whose token is not cleared for it:
 *
 *   member -> tenant only · admin -> tenant + admins · owner (admin + owner flag) -> all
 */

const MEMBER = 'member-token';
const ADMIN = 'admin-token';
const OWNER = 'owner-token';
const TENANT = 'team-alpha';

const TOKENS = [
  { token: MEMBER, actor: 'mia', role: 'member' as const },
  { token: ADMIN, actor: 'adam', role: 'admin' as const },
  { token: OWNER, actor: 'olivia', role: 'admin' as const, owner: true },
];

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Seed one memory per audience tier, all matching the query word `runbook`. */
function seed(repo: MemoryRepository): {
  legacy: CuratedMemory;
  tenant: CuratedMemory;
  admins: CuratedMemory;
  owner: CuratedMemory;
} {
  const mk = (label: string, audience?: 'tenant' | 'admins' | 'owner'): CuratedMemory => {
    const memory = makeMemory({
      title: `Runbook ${label}`,
      content: `runbook body for the ${label} audience tier`,
      tenantId: TENANT,
      metadata:
        audience === undefined
          ? { filePaths: [], tags: [] }
          : { filePaths: [], tags: [], audience },
    });
    repo.insert(memory);
    return memory;
  };
  return {
    legacy: mk('legacy'),
    tenant: mk('tenant', 'tenant'),
    admins: mk('admins', 'admins'),
    owner: mk('owner', 'owner'),
  };
}

describe('claim-level audience — read paths', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let memoryRepo: MemoryRepository;
  let m: ReturnType<typeof seed>;

  beforeEach(async () => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    app = buildApp({ db, silent: true, tokens: TOKENS });
    await app.ready();
    m = seed(memoryRepo);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function searchIds(token: string): Promise<string[]> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: auth(token),
      payload: { query: 'runbook', scope: 'curated', tenantId: TENANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { hits: Array<{ memoryId: string }>; totalCount: number };
    expect(body.totalCount).toBe(body.hits.length);
    return body.hits.map((h) => h.memoryId).sort();
  }

  const ids = (...memories: CuratedMemory[]) => memories.map((x) => x.id).sort();

  describe('POST /api/search (SQLite path)', () => {
    it('a member sees tenant-wide memories only — never admins or owner', async () => {
      expect(await searchIds(MEMBER)).toEqual(ids(m.legacy, m.tenant));
    });

    it('an admin sees tenant + admins, but not owner', async () => {
      expect(await searchIds(ADMIN)).toEqual(ids(m.legacy, m.tenant, m.admins));
    });

    it('the owner sees every audience', async () => {
      expect(await searchIds(OWNER)).toEqual(ids(m.legacy, m.tenant, m.admins, m.owner));
    });

    it('does not leak a hidden memory through totalCount, hasMore or snippets', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search',
        headers: auth(MEMBER),
        payload: {
          query: 'runbook',
          scope: 'curated',
          tenantId: TENANT,
          pagination: { page: 1, pageSize: 1 },
        },
      });
      const body = res.json() as { totalCount: number; hasMore: boolean };
      expect(body.totalCount).toBe(2);
      expect(body.hasMore).toBe(true);
      expect(res.body).not.toContain('owner audience tier');
      expect(res.body).not.toContain('admins audience tier');
    });

    it('a caller cannot raise their own standing from the request body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search',
        headers: auth(MEMBER),
        payload: {
          query: 'runbook',
          scope: 'all',
          tenantId: TENANT,
          role: 'owner',
          owner: true,
          readerRole: 'owner',
          audience: 'owner',
        },
      });
      expect(res.statusCode).toBe(200);
      const hitIds = (res.json() as { hits: Array<{ memoryId: string }> }).hits.map(
        (h) => h.memoryId,
      );
      expect(hitIds.sort()).toEqual(ids(m.legacy, m.tenant));
    });
  });

  describe('GET /api/memories', () => {
    async function listIds(token: string): Promise<string[]> {
      const res = await app.inject({
        method: 'GET',
        url: `/api/memories?tenantId=${TENANT}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as Array<{ id: string }>).map((x) => x.id).sort();
    }

    it('lists only what each role is cleared for', async () => {
      expect(await listIds(MEMBER)).toEqual(ids(m.legacy, m.tenant));
      expect(await listIds(ADMIN)).toEqual(ids(m.legacy, m.tenant, m.admins));
      expect(await listIds(OWNER)).toEqual(ids(m.legacy, m.tenant, m.admins, m.owner));
    });
  });

  describe('GET /api/memories/:id and /by-hash/:hash', () => {
    const status = async (token: string, url: string): Promise<number> =>
      (await app.inject({ method: 'GET', url, headers: auth(token) })).statusCode;

    it.each([
      ['member', MEMBER, [200, 200, 404, 404]],
      ['admin', ADMIN, [200, 200, 200, 404]],
      ['owner', OWNER, [200, 200, 200, 200]],
    ] as const)('%s: by id -> legacy/tenant/admins/owner = %j', async (_name, token, expected) => {
      const order = [m.legacy, m.tenant, m.admins, m.owner];
      const byId = await Promise.all(order.map((x) => status(token, `/api/memories/${x.id}`)));
      expect(byId).toEqual(expected);
      const byHash = await Promise.all(
        order.map((x) => status(token, `/api/memories/by-hash/${x.contentHash}`)),
      );
      expect(byHash).toEqual(expected);
    });

    it('a hidden memory answers exactly like a missing one (no existence disclosure)', async () => {
      const hidden = await app.inject({
        method: 'GET',
        url: `/api/memories/${m.owner.id}`,
        headers: auth(ADMIN),
      });
      const missingId = randomUUID();
      const missing = await app.inject({
        method: 'GET',
        url: `/api/memories/${missingId}`,
        headers: auth(ADMIN),
      });
      expect(hidden.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect((hidden.json() as { error: string }).error).toBe(`Memory ${m.owner.id} not found`);
      expect((missing.json() as { error: string }).error).toBe(`Memory ${missingId} not found`);
      expect(hidden.body).not.toContain('owner audience tier');
    });

    it('resolve_links never resolves a link to a memory the caller may not read', async () => {
      const linker = makeMemory({
        title: 'Linker note',
        content: 'see [[Runbook owner]] and [[Runbook tenant]]',
        tenantId: TENANT,
      });
      memoryRepo.insert(linker);
      const fetchContent = async (token: string): Promise<string> =>
        (
          (
            await app.inject({
              method: 'GET',
              url: `/api/memories/${linker.id}?resolve_links=true`,
              headers: auth(token),
            })
          ).json() as { content: string }
        ).content;

      const asMember = await fetchContent(MEMBER);
      expect(asMember).toContain(m.tenant.id);
      expect(asMember).not.toContain(m.owner.id);
      const asOwner = await fetchContent(OWNER);
      expect(asOwner).toContain(m.tenant.id);
      expect(asOwner).toContain(m.owner.id);
    });
  });

  describe('admin write routes that echo the memory back', () => {
    it('an admin cannot transition an owner-only memory (404, state unchanged)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${m.owner.id}/transition`,
        headers: auth(ADMIN),
        payload: { to: 'deprecated', ...makeTransitionBody() },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('owner audience tier');
      expect(memoryRepo.findById(m.owner.id)?.lifecycle).toBe('active');
    });

    it('an admin cannot recategorize an owner-only memory (404, category unchanged)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${m.owner.id}/recategorize`,
        headers: auth(ADMIN),
        payload: {
          category: 'decision',
          reason: 'fix',
          actor: { type: 'human', id: 'adam' },
        },
      });
      expect(res.statusCode).toBe(404);
      expect(memoryRepo.findById(m.owner.id)?.category).toBe(m.owner.category);
    });

    it('the owner can transition an owner-only memory', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${m.owner.id}/transition`,
        headers: auth(OWNER),
        payload: { to: 'deprecated', ...makeTransitionBody() },
      });
      expect(res.statusCode).toBe(200);
      expect(memoryRepo.findById(m.owner.id)?.lifecycle).toBe('deprecated');
    });

    it('an admin can still transition an admins-audience memory', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${m.admins.id}/transition`,
        headers: auth(ADMIN),
        payload: { to: 'deprecated', ...makeTransitionBody() },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('graph routes', () => {
    beforeEach(() => {
      const links = new MemoryLinksRepository(db);
      const link = (source: string, target: string) =>
        links.insert({
          id: randomUUID(),
          sourceMemoryId: source,
          targetMemoryId: target,
          linkType: 'relates_to',
          weight: 1,
          createdBy: 'test',
          source: 'manual',
          importBatchId: null,
          createdAt: '2026-01-15T10:00:00.000Z',
        });
      link(m.tenant.id, m.admins.id);
      link(m.tenant.id, m.owner.id);
      link(m.tenant.id, m.legacy.id);
    });

    const neighborIds = async (token: string, route: 'neighbors' | 'graph'): Promise<string[]> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/memories/${m.tenant.id}/${route}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as Array<{ memoryId: string }>).map((n) => n.memoryId).sort();
    };

    it.each(['neighbors', 'graph'] as const)(
      '%s drops links to memories the caller may not read',
      async (route) => {
        expect(await neighborIds(MEMBER, route)).toEqual(ids(m.legacy));
        expect(await neighborIds(ADMIN, route)).toEqual(ids(m.legacy, m.admins));
        expect(await neighborIds(OWNER, route)).toEqual(ids(m.legacy, m.admins, m.owner));
      },
    );

    it.each(['neighbors', 'graph'] as const)(
      '%s from a hidden start memory is a 404',
      async (route) => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memories/${m.owner.id}/${route}`,
          headers: auth(ADMIN),
        });
        expect(res.statusCode).toBe(404);
      },
    );
  });
});

describe('claim-level audience — qmd cited path', () => {
  class FakeQmd implements QmdQueryPort {
    constructor(private readonly hits: QmdCiteHit[]) {}
    query(
      _q: string,
      _scope?: SearchScope,
      _tenantId?: string,
    ): Promise<{ ok: true; value: QmdCiteHit[] }> {
      return Promise.resolve({ ok: true, value: this.hits });
    }
  }

  let db: Database.Database;
  let app: FastifyInstance;
  let m: ReturnType<typeof seed>;

  beforeEach(async () => {
    db = createTestDatabase();
    m = seed(new MemoryRepository(db));
    // An index that (wrongly) still holds every tier — e.g. built before a memory
    // was narrowed. The read-time filter must still hold the line.
    const hits = [m.legacy, m.tenant, m.admins, m.owner].map((x, i) => ({
      file: `qmd://kb-curated/${x.id}.md`,
      score: 10 - i,
      snippet: `snippet ${x.title}`,
      collection: 'kb-curated',
    }));
    hits.push({
      file: 'qmd://kb-curated/not-a-stored-memory.md',
      score: 1,
      snippet: 'orphan',
      collection: 'kb-curated',
    });
    app = buildApp({ db, silent: true, tokens: TOKENS, qmdAdapter: new FakeQmd(hits) });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const cited = async (token: string): Promise<string[]> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: auth(token),
      payload: { query: 'runbook', scope: 'curated', tenantId: TENANT },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { hits: Array<{ citation: string }> }).hits.map((h) => h.citation).sort();
  };
  const uris = (...memories: CuratedMemory[]) =>
    [
      ...memories.map((x) => `qmd://kb-curated/${x.id}.md`),
      'qmd://kb-curated/not-a-stored-memory.md',
    ].sort();

  it('filters cited hits per role even when the index still contains narrower memories', async () => {
    expect(await cited(MEMBER)).toEqual(uris(m.legacy, m.tenant));
    expect(await cited(ADMIN)).toEqual(uris(m.legacy, m.tenant, m.admins));
    expect(await cited(OWNER)).toEqual(uris(m.legacy, m.tenant, m.admins, m.owner));
  });
});

describe('claim-level audience — local single-user mode', () => {
  it('dev no-auth (loopback, no tokens) is the owner and sees every audience', async () => {
    const db = createTestDatabase();
    const m = seed(new MemoryRepository(db));
    const app = buildApp({ db, silent: true });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search',
        payload: { query: 'runbook', scope: 'curated', tenantId: TENANT },
      });
      expect((res.json() as { totalCount: number }).totalCount).toBe(4);
      const one = await app.inject({ method: 'GET', url: `/api/memories/${m.owner.id}` });
      expect(one.statusCode).toBe(200);
    } finally {
      await app.close();
      db.close();
    }
  });

  it('the legacy single shared key is an admin, NOT the owner', async () => {
    const db = createTestDatabase();
    const m = seed(new MemoryRepository(db));
    const app = buildApp({ db, silent: true, apiKey: 'shared-key' });
    await app.ready();
    try {
      const get = (id: string) =>
        app.inject({ method: 'GET', url: `/api/memories/${id}`, headers: auth('shared-key') });
      expect((await get(m.admins.id)).statusCode).toBe(200);
      expect((await get(m.owner.id)).statusCode).toBe(404);
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe('SearchService — default standing is least privilege', () => {
  it('a caller that passes no reader role is treated as a member', async () => {
    const db = createTestDatabase();
    const repo = new MemoryRepository(db);
    const m = seed(repo);
    const service = new SearchService(repo);
    const query = {
      query: 'runbook',
      scope: 'curated' as const,
      tenantId: TENANT,
      pagination: { page: 1, pageSize: 20 },
    };
    const byDefault = await service.search(query);
    expect(byDefault.hits.map((h) => h.memoryId).sort()).toEqual([m.legacy.id, m.tenant.id].sort());
    expect((await service.search(query, 'admin')).totalCount).toBe(3);
    expect((await service.search(query, 'owner')).totalCount).toBe(4);
    // An off-vocabulary standing (a bug upstream) sees nothing at all.
    expect((await service.search(query, 'root' as never)).totalCount).toBe(0);
    db.close();
  });
});

describe('readerRoleOf', () => {
  it.each([
    [{ role: 'admin', owner: true }, 'owner'],
    [{ role: 'admin', owner: false }, 'admin'],
    [{ role: 'admin' }, 'admin'],
    [{ role: 'member', owner: true }, 'member'],
    [{ role: 'member' }, 'member'],
    [{}, 'member'],
  ] as const)('%j -> %s', (request, expected) => {
    expect(readerRoleOf(request)).toBe(expected);
  });
});

describe('token registry — owner flag', () => {
  it('surfaces owner on an admin record and omits it otherwise (back-compat shape)', () => {
    const registry = new InMemoryTokenRegistry(TOKENS);
    expect(registry.resolve(OWNER)).toEqual({ actor: 'olivia', role: 'admin', owner: true });
    expect(registry.resolve(ADMIN)).toEqual({ actor: 'adam', role: 'admin' });
    expect(registry.resolve(MEMBER)).toEqual({ actor: 'mia', role: 'member' });
  });

  it('drops an owner flag on a member record — owner never raises a member', () => {
    const registry = new InMemoryTokenRegistry([
      { token: 't', actor: 'eve', role: 'member', owner: true },
    ]);
    expect(registry.resolve('t')).toEqual({ actor: 'eve', role: 'member' });
  });

  it('parses owner from tokens JSON only when it is literally true on an admin', () => {
    const records = loadTokenRecords({
      tokensJson: JSON.stringify([
        { token: 'a', actor: 'a', role: 'admin', owner: true },
        { token: 'b', actor: 'b', role: 'admin', owner: 'true' },
        { token: 'c', actor: 'c', role: 'admin', owner: 1 },
        { token: 'd', actor: 'd', role: 'member', owner: true },
        { token: 'e', actor: 'e', role: 'admin' },
        { token: 'f', actor: 'f', owner: true },
      ]),
    });
    expect(records.map((r) => [r.actor, r.role, r.owner])).toEqual([
      ['a', 'admin', true],
      ['b', 'admin', undefined],
      ['c', 'admin', undefined],
      ['d', 'member', undefined],
      ['e', 'admin', undefined],
      ['f', 'member', undefined],
    ]);
  });

  it('the single shared apiKey is never the owner', () => {
    expect(loadTokenRecords({ apiKey: 'k' })).toEqual([
      { token: 'k', actor: 'shared', role: 'admin' },
    ]);
  });
});

describe('claim-level audience — declared at capture, carried by promotion', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let candidateRepo: CandidateRepository;
  let memoryRepo: MemoryRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
    memoryRepo = new MemoryRepository(db);
    app = buildApp({ db, silent: true, tokens: TOKENS });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it.each(['tenant', 'admins', 'owner'] as const)(
    'a candidate captured with audience %s promotes to a memory with the same audience',
    async (audience) => {
      const candidate = makeCandidate({
        tenantId: TENANT,
        content: `capture-time audience declaration for ${audience}`,
        metadata: { filePaths: [], tags: [], audience },
      });
      const posted = await app.inject({
        method: 'POST',
        url: '/api/candidates',
        headers: auth(OWNER),
        payload: candidate,
      });
      expect(posted.statusCode).toBe(201);
      expect(candidateRepo.findById(candidate.id)?.metadata.audience).toBe(audience);

      const promoted = await app.inject({
        method: 'POST',
        url: `/api/candidates/${candidate.id}/promote?tenantId=${TENANT}`,
        headers: auth(OWNER),
      });
      expect(promoted.statusCode).toBe(200);
      const memoryId = (promoted.json() as { id: string }).id;
      expect(memoryRepo.findById(memoryId)?.metadata.audience).toBe(audience);
    },
  );

  it('a candidate with no audience promotes to a memory with no audience (unchanged behavior)', async () => {
    const candidate = makeCandidate({ tenantId: TENANT, content: 'no audience declared here' });
    candidateRepo.insert(candidate, computeContentHash(candidate.content));
    const promoted = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/promote?tenantId=${TENANT}`,
      headers: auth(ADMIN),
    });
    expect(promoted.statusCode).toBe(200);
    const memory = memoryRepo.findById((promoted.json() as { id: string }).id);
    expect(memory?.metadata.audience).toBeUndefined();
    const visible = await app.inject({
      method: 'GET',
      url: `/api/memories/${memory!.id}`,
      headers: auth(MEMBER),
    });
    expect(visible.statusCode).toBe(200);
  });

  it('rejects a capture declaring an off-vocabulary audience (400, nothing stored)', async () => {
    const candidate = makeCandidate({ tenantId: TENANT });
    const res = await app.inject({
      method: 'POST',
      url: '/api/candidates',
      headers: auth(ADMIN),
      payload: { ...candidate, metadata: { ...candidate.metadata, audience: 'board' } },
    });
    expect(res.statusCode).toBe(400);
    expect(candidateRepo.findById(candidate.id)).toBeNull();
  });

  it('a member may narrow their own proposal; the narrowed memory is then hidden from members', async () => {
    const candidate = makeCandidate({
      tenantId: TENANT,
      content: 'member proposes something meant for admins',
      metadata: { filePaths: [], tags: [], audience: 'admins' },
    });
    const posted = await app.inject({
      method: 'POST',
      url: '/api/candidates',
      headers: auth(MEMBER),
      payload: candidate,
    });
    expect(posted.statusCode).toBe(201);
    const promoted = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/promote?tenantId=${TENANT}`,
      headers: auth(ADMIN),
      payload: { reviewed: true },
    });
    // A member proposal may be quarantined behind review; whichever way the
    // promotion gate answers, an audience can never have been WIDENED.
    if (promoted.statusCode === 200) {
      const id = (promoted.json() as { id: string }).id;
      expect(memoryRepo.findById(id)?.metadata.audience).toBe('admins');
      const asMember = await app.inject({
        method: 'GET',
        url: `/api/memories/${id}`,
        headers: auth(MEMBER),
      });
      expect(asMember.statusCode).toBe(404);
    } else {
      expect(candidateRepo.findById(candidate.id)?.metadata.audience).toBe('admins');
    }
  });
});
