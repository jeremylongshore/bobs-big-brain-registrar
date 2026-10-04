import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { redactMemory } from '@qmd-team-intent-kb/curator';
import { buildApp } from '../app.js';
import { makeCandidate, makeMemory } from './fixtures.js';

/**
 * Governed audience narrowing over the API (Epic K bead K3), and the API-side
 * dedup that keeps redacted text from coming back. Real SQLite store.
 */

const MEMBER = 'member-token';
const ADMIN = 'admin-token';
const OWNER = 'owner-token';
const SCOPED = 'scoped-admin-token';
const TENANT = 'team-alpha';

const TOKENS = [
  { token: MEMBER, actor: 'mia', role: 'member' as const },
  { token: ADMIN, actor: 'adam', role: 'admin' as const },
  { token: OWNER, actor: 'olivia', role: 'admin' as const, owner: true },
  { token: SCOPED, actor: 'sam', role: 'admin' as const, tenants: ['team-beta'] },
];
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('POST /api/memories/:id/narrow-audience', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let memoryRepo: MemoryRepository;
  let auditRepo: AuditRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    auditRepo = new AuditRepository(db);
    app = buildApp({ db, silent: true, tokens: TOKENS });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function seed(audience?: 'tenant' | 'admins' | 'owner'): CuratedMemory {
    const memory = makeMemory({
      tenantId: TENANT,
      metadata:
        audience === undefined
          ? { filePaths: [], tags: [] }
          : { filePaths: [], tags: [], audience },
    });
    memoryRepo.insert(memory);
    return memory;
  }

  function narrow(token: string, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/memories/${id}/narrow-audience`,
      headers: auth(token),
      payload,
    });
  }

  const audienceOf = (id: string) => memoryRepo.findById(id)!.metadata.audience;

  it('an admin narrows tenant -> admins; the receipt names the authenticated caller', async () => {
    const memory = seed();
    const res = await narrow(ADMIN, memory.id, {
      to: 'admins',
      reason: 'customer contact details',
      // A body-supplied actor is ignored: the token decides who acted.
      actor: { type: 'human', id: 'someone-else' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { memoryId: string; from: string; to: string; auditEventId: string };
    expect(body).toMatchObject({ memoryId: memory.id, from: 'tenant', to: 'admins' });
    // The response carries no memory content.
    expect(res.body).not.toContain(memory.content);

    expect(audienceOf(memory.id)).toBe('admins');
    const events = auditRepo.findByMemory(memory.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: body.auditEventId,
      action: 'audience_narrowed',
      actor: { type: 'human', id: 'adam' },
      reason: 'customer contact details',
      details: { from: 'tenant', to: 'admins' },
    });
    expect(verifyAuditChain(auditRepo).breaks).toEqual([]);
  });

  it('after narrowing, a member no longer sees the memory', async () => {
    const memory = seed();
    const get = () =>
      app.inject({ method: 'GET', url: `/api/memories/${memory.id}`, headers: auth(MEMBER) });
    expect((await get()).statusCode).toBe(200);
    expect((await narrow(ADMIN, memory.id, { to: 'admins', reason: 'r' })).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(404);
  });

  it('an admin may narrow to owner and then can no longer read or change it', async () => {
    const memory = seed('admins');
    expect((await narrow(ADMIN, memory.id, { to: 'owner', reason: 'r' })).statusCode).toBe(200);
    expect(audienceOf(memory.id)).toBe('owner');
    const again = await narrow(ADMIN, memory.id, { to: 'owner', reason: 'r' });
    expect(again.statusCode).toBe(404);
  });

  it('a member is refused (403) and nothing changes', async () => {
    const memory = seed();
    const res = await narrow(MEMBER, memory.id, { to: 'admins', reason: 'r' });
    expect(res.statusCode).toBe(403);
    expect(audienceOf(memory.id)).toBeUndefined();
    expect(auditRepo.findByMemory(memory.id)).toEqual([]);
  });

  it('an unauthenticated caller is refused (401)', async () => {
    const memory = seed();
    const res = await app.inject({
      method: 'POST',
      url: `/api/memories/${memory.id}/narrow-audience`,
      payload: { to: 'admins', reason: 'r' },
    });
    expect(res.statusCode).toBe(401);
    expect(audienceOf(memory.id)).toBeUndefined();
  });

  it.each([
    ['admins', 'tenant', 'widening'],
    ['owner', 'admins', 'widening'],
    ['owner', 'tenant', 'widening'],
    ['admins', 'admins', 'same'],
    ['tenant', 'board', 'unknown_to'],
  ] as const)('refuses %s -> %s with 400 %s', async (from, to, code) => {
    const memory = seed(from);
    const res = await narrow(OWNER, memory.id, { to, reason: 'r' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code });
    expect(audienceOf(memory.id)).toBe(from);
    expect(auditRepo.findByMemory(memory.id)).toEqual([]);
  });

  it('the widening refusal says so plainly', async () => {
    const memory = seed('owner');
    const res = await narrow(OWNER, memory.id, { to: 'tenant', reason: 'r' });
    expect((res.json() as { error: string }).error).toContain('Refusing to widen');
  });

  it('refuses a missing or blank reason and a non-string target (400)', async () => {
    const memory = seed();
    expect((await narrow(ADMIN, memory.id, { to: 'admins' })).statusCode).toBe(400);
    expect((await narrow(ADMIN, memory.id, { reason: 'r' })).statusCode).toBe(400);
    expect((await narrow(ADMIN, memory.id, { to: 7, reason: 'r' })).statusCode).toBe(400);
    const blank = await narrow(ADMIN, memory.id, { to: 'admins', reason: '   ' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ code: 'missing_reason' });
    expect(audienceOf(memory.id)).toBeUndefined();
  });

  it('answers 404 for an unknown id', async () => {
    const res = await narrow(ADMIN, randomUUID(), { to: 'admins', reason: 'r' });
    expect(res.statusCode).toBe(404);
  });

  it('an admin cannot narrow an owner-only memory they cannot read (404)', async () => {
    const memory = seed('owner');
    const res = await narrow(ADMIN, memory.id, { to: 'owner', reason: 'r' });
    expect(res.statusCode).toBe(404);
    expect(auditRepo.findByMemory(memory.id)).toEqual([]);
  });

  it('a token scoped to another tenant gets 404, not a narrowing', async () => {
    const memory = seed();
    const res = await narrow(SCOPED, memory.id, { to: 'admins', reason: 'r' });
    expect(res.statusCode).toBe(404);
    expect(audienceOf(memory.id)).toBeUndefined();
  });
});

describe('redacted content cannot come back through the API (K3)', () => {
  const SECRET = 'zq' + 'Synth' + 'Quay' + '5Tn2Lw8Rc4Jd';
  const ORIGINAL = `The cutover is done. The account passphrase we set is ${SECRET} for now.`;
  const REPLACEMENT = '[REDACTED] This memory held plaintext credentials; they were rotated.';

  let db: Database.Database;
  let app: FastifyInstance;
  let candidateRepo: CandidateRepository;
  let memoryRepo: MemoryRepository;
  let auditRepo: AuditRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
    memoryRepo = new MemoryRepository(db);
    auditRepo = new AuditRepository(db);
    app = buildApp({ db, silent: true });
    await app.ready();

    const memory = makeMemory({ tenantId: TENANT, content: ORIGINAL });
    memoryRepo.insert(memory);
    const { result } = redactMemory(
      {
        memoryId: memory.id,
        tenantId: TENANT,
        actor: 'jeremy',
        reason: 'plaintext credentials',
        mode: { kind: 'replacement', content: REPLACEMENT },
      },
      { memoryRepo, candidateRepo, auditRepo },
    );
    expect(result.ok).toBe(true);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('intake refuses the original text with 422 and stores nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/candidates',
      payload: makeCandidate({ tenantId: TENANT, content: ORIGINAL }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'redacted_content' });
    expect(res.body).not.toContain(SECRET);
    expect(candidateRepo.count()).toBe(0);
  });

  it('promotion refuses a candidate row that still holds the original text', async () => {
    // A row that predates the redaction and was not a copy of that memory's
    // lineage by hash — planted directly, as a legacy row would be.
    const id = randomUUID();
    db.prepare(
      `INSERT INTO candidates (id, status, source, content, title, category, trust_level,
        author_json, tenant_id, metadata_json, pre_policy_flags_json, content_hash, captured_at)
       VALUES (@id,'inbox','mcp',@content,'legacy row','reference','medium',
        @author,@tenant,'{"filePaths":[],"tags":[]}',
        '{"potentialSecret":false,"lowConfidence":false,"duplicateSuspect":false}',@hash,@at)`,
    ).run({
      id,
      content: ORIGINAL,
      author: JSON.stringify({ type: 'ai', id: 'claude-1' }),
      tenant: TENANT,
      hash: computeContentHash(ORIGINAL),
      at: '2026-01-15T10:00:00.000Z',
    });
    const before = memoryRepo.count();

    const res = await app.inject({
      method: 'POST',
      url: `/api/candidates/${id}/promote?tenantId=${TENANT}`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'redacted_content' });
    expect(res.body).not.toContain(SECRET);
    expect(memoryRepo.count()).toBe(before);
  });

  it('still accepts unrelated content', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/candidates',
      payload: makeCandidate({
        tenantId: TENANT,
        content: 'An unrelated and harmless convention.',
      }),
    });
    expect(res.statusCode).toBe(201);
  });
});
