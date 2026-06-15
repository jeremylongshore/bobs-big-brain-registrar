import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase, MemoryRepository } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';
import { makeMemory } from './fixtures.js';

/**
 * The governance write gate: members read + propose; admins promote/edit/import.
 * Enforced server-side regardless of what tools a client exposes.
 */
describe('write gate — admin-only governance mutations', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let memoryRepo: MemoryRepository;

  const ADMIN = 'jeremy-token';
  const MEMBER = 'pablo-token';

  beforeEach(async () => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    app = buildApp({
      db,
      silent: true,
      tokens: [
        { token: ADMIN, actor: 'jeremy', role: 'admin' },
        { token: MEMBER, actor: 'pablo', role: 'member' },
      ],
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function transition(token: string, id: string) {
    return app.inject({
      method: 'POST',
      url: `/api/memories/${id}/transition`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { to: 'archived', reason: 'test', actor: { type: 'human', id: 'x' } },
    });
  }

  it('blocks a member from transitioning (promoting) a memory with 403', async () => {
    const memory = makeMemory({ lifecycle: 'active' });
    memoryRepo.insert(memory);
    const res = await transition(MEMBER, memory.id);
    expect(res.statusCode).toBe(403);
  });

  it('lets an admin transition a memory (not 403)', async () => {
    const memory = makeMemory({ lifecycle: 'active' });
    memoryRepo.insert(memory);
    const res = await transition(ADMIN, memory.id);
    expect(res.statusCode).not.toBe(403);
  });

  it('blocks a member from creating a policy with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { Authorization: `Bearer ${MEMBER}` },
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a member READ memories (gate is mutation-only)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories?tenantId=team-alpha',
      headers: { Authorization: `Bearer ${MEMBER}` },
    });
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
  });

  it('lets a member PROPOSE (POST /api/candidates is not gated)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/candidates',
      headers: { Authorization: `Bearer ${MEMBER}` },
      payload: {}, // invalid body → expect 400 (validation), crucially NOT 403
    });
    expect(res.statusCode).not.toBe(403);
  });

  it('lets a member SEARCH (read-shaped POST is not gated)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: { Authorization: `Bearer ${MEMBER}` },
      payload: { query: 'x', scope: 'curated' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('dev mode (no auth) runs as admin — writes allowed', async () => {
    const devDb = createTestDatabase();
    const devApp = buildApp({ db: devDb, silent: true });
    await devApp.ready();
    try {
      const repo = new MemoryRepository(devDb);
      const memory = makeMemory({ lifecycle: 'active' });
      repo.insert(memory);
      const res = await devApp.inject({
        method: 'POST',
        url: `/api/memories/${memory.id}/transition`,
        payload: { to: 'archived', reason: 'test', actor: { type: 'human', id: 'x' } },
      });
      expect(res.statusCode).not.toBe(403);
    } finally {
      await devApp.close();
      devDb.close();
    }
  });
});
