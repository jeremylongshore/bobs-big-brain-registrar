import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  createTestDatabase,
  MemoryRepository,
  MemoryLinksRepository,
} from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';
import { makeMemory } from './fixtures.js';

describe('graph read scope', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let memories: MemoryRepository;
  let links: MemoryLinksRepository;
  let alpha: string;
  let beta: string;
  const seed = (tenantId = 'alpha', audience?: 'tenant' | 'admins' | 'owner') => {
    const id = randomUUID();
    memories.insert(
      makeMemory({
        id,
        tenantId,
        metadata: { filePaths: [], tags: [], ...(audience === undefined ? {} : { audience }) },
      }),
    );
    return id;
  };
  const link = (sourceMemoryId: string, targetMemoryId: string, weight = 1) => {
    links.insert({
      id: randomUUID(),
      sourceMemoryId,
      targetMemoryId,
      linkType: 'relates_to',
      weight,
      createdBy: 'test',
      source: 'manual',
      importBatchId: null,
      createdAt: '2026-10-26T00:00:00Z',
    });
  };
  const read = (id: string, route = 'graph', token = 'member', query = '') =>
    app.inject({
      method: 'GET',
      url: `/api/memories/${id}/${route}${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  beforeEach(async () => {
    db = createTestDatabase();
    memories = new MemoryRepository(db);
    links = new MemoryLinksRepository(db);
    alpha = seed();
    beta = seed('beta');
    app = buildApp({
      db,
      silent: true,
      tokens: [
        { token: 'member', actor: 'test', role: 'member', tenants: ['alpha'] },
        { token: 'multi', actor: 'test', role: 'admin', tenants: ['alpha', 'beta'] },
        { token: 'unscoped', actor: 'test', role: 'admin' },
        { token: 'owner', actor: 'test', role: 'admin', owner: true },
      ],
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  for (const route of ['neighbors', 'graph']) {
    it.each([
      ['member', '?tenantId='],
      ['member', '?tenantId=alpha&tenantId=beta'],
      ['unscoped', '?tenantId='],
      ['unscoped', '?tenantId=alpha&tenantId=beta'],
    ])(`${route} rejects malformed tenant selection (%s %s)`, async (token, query) => {
      expect((await read(alpha, route, token, query)).statusCode).toBe(400);
    });

    it.each(['', '?tenantId=alpha'])(`${route} refuses a foreign root (%s)`, async (query) => {
      expect((await read(beta, route, 'member', query)).statusCode).toBe(404);
    });
    it(`${route} filters foreign endpoints and preserves allowed edges`, async () => {
      const allowed = seed();
      link(alpha, beta);
      link(beta, alpha);
      link(alpha, allowed);
      const result = await read(alpha, route);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual([expect.objectContaining({ memoryId: allowed })]);
    });
    it(`${route} binds multi-tenant reads to the selected tenant`, async () => {
      expect((await read(alpha, route, 'multi')).statusCode).toBe(400);
      expect((await read(beta, route, 'multi', '?tenantId=alpha')).statusCode).toBe(404);
      expect((await read(beta, route, 'multi', '?tenantId=beta')).statusCode).toBe(200);
      expect((await read(alpha, route, 'member', '?tenantId=beta')).statusCode).toBe(403);
    });
    it(`${route} preserves unscoped reads and honors an explicit selection`, async () => {
      link(alpha, beta);
      expect((await read(alpha, route, 'unscoped')).json()).toEqual([
        expect.objectContaining({ memoryId: beta }),
      ]);
      expect((await read(alpha, route, 'unscoped', '?tenantId=alpha')).json()).toEqual([]);
      expect((await read(beta, route, 'unscoped', '?tenantId=alpha')).statusCode).toBe(404);
    });
  }

  it.each(['tenant', 'audience'] as const)(
    'cannot reach a readable node through a forbidden %s bridge',
    async (boundary) => {
      const bridge = boundary === 'tenant' ? beta : seed('alpha', 'owner');
      const destination = seed();
      link(alpha, bridge);
      link(bridge, destination);
      expect((await read(alpha)).json()).toEqual([]);
    },
  );

  it('ranks only allowed paths, retains direction and depth, and bounds cycles', async () => {
    const hidden = seed('alpha', 'owner');
    const first = seed();
    const second = seed();
    const destination = seed();
    const incoming = seed();
    link(alpha, hidden);
    link(hidden, destination, 1); // Forbidden shortcut must not set depth or weight.
    link(alpha, first);
    link(alpha, second);
    link(first, second);
    link(first, destination, 0.3);
    link(second, destination, 0.8);
    link(destination, alpha);
    link(incoming, alpha);
    const shallow = (await read(alpha, 'graph', 'member', '?depth=1')).json<
      Array<{ memoryId: string }>
    >();
    expect(shallow.map((n) => n.memoryId).sort()).toEqual([first, second].sort());
    const nodes = (await read(alpha, 'graph', 'member', '?depth=5')).json<
      Array<{ memoryId: string; depth: number; weight: number }>
    >();
    expect(nodes).toHaveLength(3);
    expect(nodes.find((n) => n.memoryId === destination)).toMatchObject({ depth: 2, weight: 0.8 });
    expect(nodes.find((n) => n.memoryId === second)).toMatchObject({ depth: 1, weight: 1 });
    expect((await read(alpha, 'neighbors')).json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memoryId: incoming, direction: 'incoming' }),
      ]),
    );
    expect((await read(alpha, 'graph', 'owner', '?depth=2')).json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memoryId: hidden, depth: 1 }),
        expect.objectContaining({ memoryId: destination, depth: 2, weight: 1 }),
      ]),
    );
  });
});
