import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  createTestDatabase,
  MemoryRepository,
  MemoryLinksRepository,
  readContradictionReferences,
} from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { SearchQuery } from '@qmd-team-intent-kb/schema';
import { buildApp } from '../app.js';
import { SearchService } from '../services/search-service.js';
import type { QmdQueryPort } from '../services/search-service.js';

let db: Database.Database;
let app: FastifyInstance | undefined;
let repo: MemoryRepository;
beforeEach(() => {
  db = createTestDatabase();
  repo = new MemoryRepository(db);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  db.close();
  vi.useRealTimers();
});
const query = SearchQuery.parse({
  query: 'needle',
  scope: 'curated',
  tenantId: 'acme',
  pagination: { page: 1, pageSize: 1 },
});
function fixture() {
  const primary = makeMemory({ tenantId: 'acme', title: 'needle primary' });
  const counterpart = makeMemory({ tenantId: 'acme', title: 'visible counterpart' });
  repo.insert(primary);
  repo.insert(counterpart);
  new MemoryLinksRepository(db).insert({
    id: randomUUID(),
    sourceMemoryId: counterpart.id,
    targetMemoryId: primary.id,
    linkType: 'contradicts',
    weight: 1,
    createdBy: 'synthetic-reviewer',
    source: 'curator',
    importBatchId: null,
    createdAt: primary.updatedAt,
  });
  const qmd: QmdQueryPort = {
    query: async () => ({
      ok: true,
      value: [
        {
          file: `qmd://kb-curated/${primary.id}.md`,
          score: 0.9,
          snippet: 'needle primary',
          collection: 'kb-curated',
        },
      ],
    }),
  };
  return { primary, counterpart, qmd };
}

describe('search contradiction metadata integration', () => {
  it.each(['cited', 'sqlite'])(
    'preserves %s ranking/pagination/citations while adding references',
    async (path) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-27T10:00:00.000Z'));
      const { counterpart, qmd } = fixture();
      const port = path === 'cited' ? qmd : undefined;
      const baseline = await new SearchService(repo, port).search(query);
      const annotated = await new SearchService(repo, port, (id, scope) =>
        readContradictionReferences(db, id, scope),
      ).search(query);
      expect(annotated.hits[0]!.contradictions).toEqual({
        status: 'available',
        references: [{ memoryId: counterpart.id, title: counterpart.title }],
      });
      expect({
        ...annotated,
        hits: annotated.hits.map(({ contradictions: _metadata, ...hit }) => hit),
      }).toEqual(baseline);
    },
  );

  it('does not turn an absent graph reader into a measured zero', async () => {
    fixture();
    expect((await new SearchService(repo).search(query)).hits[0]).not.toHaveProperty(
      'contradictions',
    );
  });

  it('keeps cited retrieval usable on graph failure and unresolved citations without false empty references', async () => {
    const { qmd } = fixture();
    const result = await new SearchService(repo, qmd, () => {
      throw new Error('private store detail');
    }).search(query);
    expect(result.hits[0]!.contradictions).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private store detail');
    const unknown: QmdQueryPort = {
      query: async () => ({
        ok: true,
        value: [
          {
            file: 'qmd://kb-curated/legacy.md',
            score: 1,
            snippet: 'legacy',
            collection: 'kb-curated',
          },
        ],
      }),
    };
    expect(
      (
        await new SearchService(repo, unknown, (id, scope) =>
          readContradictionReferences(db, id, scope),
        ).search(query)
      ).hits[0]!.contradictions,
    ).toEqual({ status: 'unavailable' });
  });

  it.each(['cited', 'sqlite'])(
    'HTTP %s binds graph visibility to the token, not body role/tenant claims',
    async (path) => {
      const { primary, counterpart, qmd } = fixture();
      db.prepare(
        "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.audience','owner') WHERE id=?",
      ).run(counterpart.id);
      app = buildApp({
        db,
        silent: true,
        qmdAdapter: path === 'cited' ? qmd : undefined,
        tokens: [
          { token: 'synthetic-member', actor: 'member', role: 'member', tenants: ['acme'] },
          {
            token: 'synthetic-owner',
            actor: 'owner',
            role: 'admin',
            owner: true,
            tenants: ['acme'],
          },
        ],
      });
      await app.ready();
      const before = db.prepare('SELECT total_changes() AS count').get();
      const search = (token: string, extra = {}) =>
        app!.inject({
          method: 'POST',
          url: '/api/search',
          headers: { authorization: `Bearer ${token}` },
          payload: { query: 'needle', scope: 'curated', ...extra },
        });
      const member = await search('synthetic-member', { role: 'owner', owner: true });
      expect(member.statusCode).toBe(200);
      expect(member.json().hits[0].memoryId).toBe(primary.id);
      expect(member.json().hits[0].contradictions).toEqual({ status: 'available', references: [] });
      expect(member.body).not.toContain(counterpart.id);
      expect(member.body).not.toContain(counterpart.title);
      const owner = await search('synthetic-owner');
      expect(owner.json().hits[0].contradictions).toEqual({
        status: 'available',
        references: [{ memoryId: counterpart.id, title: counterpart.title }],
      });
      expect((await search('synthetic-member', { tenantId: 'foreign' })).statusCode).toBe(403);
      expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    },
  );
});
