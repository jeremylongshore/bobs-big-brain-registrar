import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createTestDatabase,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { Curator } from '@qmd-team-intent-kb/curator';
import { buildApp } from '../app.js';
import { makeCandidate, makePolicy } from './fixtures.js';

describe('explicit review of Registrar MCP AI proposals', () => {
  let db: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof buildApp>;
  let candidates: CandidateRepository;
  let memories: MemoryRepository;
  let audit: AuditRepository;
  let policies: PolicyRepository;
  const tenantId = 'mcp-review-fixture';

  beforeEach(async () => {
    db = createTestDatabase();
    candidates = new CandidateRepository(db);
    memories = new MemoryRepository(db);
    audit = new AuditRepository(db);
    policies = new PolicyRepository(db);
    app = buildApp({
      db,
      silent: true,
      tokens: [
        { token: 'fixture-admin', actor: 'fixture-reviewer', role: 'admin', tenants: [tenantId] },
        { token: 'fixture-member', actor: 'fixture-member', role: 'member', tenants: [tenantId] },
      ],
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function seed() {
    const row = makeCandidate({
      tenantId,
      source: 'mcp',
      author: { type: 'ai', id: 'mcp-server' },
      trustLevel: 'medium',
    });
    candidates.insert(row, computeContentHash(row.content));
    return row;
  }

  const promote = (id: string, token = 'fixture-admin', tenant = tenantId) =>
    app.inject({
      method: 'POST',
      url: `/api/candidates/${id}/promote?tenantId=${tenant}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { actorType: 'ai', reason: 'Reviewed this synthetic discovery proposal.' },
    });

  it('keeps automatic governance blocked, then permits authenticated admin review with a receipt', async () => {
    const row = seed();
    const curator = new Curator(
      { candidateRepo: candidates, memoryRepo: memories, policyRepo: policies, auditRepo: audit },
      { tenantId },
    );
    expect(curator.processSingle(row).outcome).toBe('flagged');
    expect(curator.processSingle(row).outcome).toBe('flagged');
    expect(audit.findByMemoryAndTenant(row.id, tenantId)).toHaveLength(0);
    expect(memories.existsForCandidate(row.id, tenantId)).toBe(false);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/candidates?tenantId=${tenantId}&status=inbox`,
      headers: { authorization: 'Bearer fixture-admin' },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain(row.id);
    const response = await promote(row.id);
    expect(response.statusCode).toBe(200);
    const memory = response.json() as { id: string };
    expect(candidates.findById(row.id)?.status).toBe('promoted');
    expect(audit.findByMemoryAndTenant(memory.id, tenantId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'promoted',
          actor: { type: 'ai', id: 'fixture-reviewer' },
        }),
      ]),
    );
    expect(verifyAuditChain(audit).breaks).toHaveLength(0);
  });

  for (const [token, tenant, status] of [
    ['fixture-member', tenantId, 403],
    ['invalid-fixture-token', tenantId, 401],
    ['fixture-admin', 'other-tenant', 403],
  ] as const) {
    it(`refuses ${token}/${tenant} without admitting the proposal`, async () => {
      const row = seed();
      expect((await promote(row.id, token, tenant)).statusCode).toBe(status);
      expect(memories.existsForCandidate(row.id, tenantId)).toBe(false);
      expect(candidates.findById(row.id)).toEqual(row);
      expect(audit.findByMemoryAndTenant(row.id, tenantId)).toHaveLength(0);
    });
  }

  it('does not turn explicit review into a tenant-policy bypass', async () => {
    const row = seed();
    policies.insert(
      makePolicy({
        tenantId,
        rules: [
          {
            id: 'fixture-minimum-length',
            type: 'content_length',
            action: 'reject',
            enabled: true,
            priority: 0,
            parameters: { min: 10_000 },
          },
        ],
      }),
    );
    expect((await promote(row.id)).statusCode).toBe(422);
    expect(memories.existsForCandidate(row.id, tenantId)).toBe(false);
    expect(candidates.findById(row.id)?.status).toBe('inbox');
  });
});
