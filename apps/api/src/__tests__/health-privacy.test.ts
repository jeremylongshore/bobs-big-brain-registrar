import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase, PolicyRepository } from '@qmd-team-intent-kb/store';
import { buildRecommendedPolicy } from '@qmd-team-intent-kb/policy-engine';
import { buildApp } from '../app.js';

describe('anonymous liveness and global diagnostics standing', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  beforeEach(async () => {
    db = createTestDatabase();
    for (const tenant of ['private-alpha', 'private-beta']) {
      const policy = buildRecommendedPolicy(tenant, new Date().toISOString());
      new PolicyRepository(db).insert({
        ...policy,
        name: `Private policy ${tenant}`,
        rules: policy.rules.filter((rule) => rule.type === 'secret_detection'),
      });
    }
    app = buildApp({
      db,
      silent: true,
      tokens: [
        { token: 'fixture-global-admin', actor: 'operator', role: 'admin' },
        { token: 'fixture-member', actor: 'member', role: 'member' },
        {
          token: 'fixture-tenant-admin',
          actor: 'tenant-admin',
          role: 'admin',
          tenants: ['private-alpha'],
        },
        {
          token: 'fixture-multi-admin',
          actor: 'multi-admin',
          role: 'admin',
          tenants: ['private-alpha', 'private-beta'],
        },
      ],
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('keeps anonymous liveness minimal even when multiple tenants have dormant rules', async () => {
    const result = await app.inject({ method: 'GET', url: '/api/health' });
    expect(result.statusCode).toBe(200);
    expect(Object.keys(result.json()).sort()).toEqual([
      'dbConnected',
      'status',
      'uptime',
      'version',
    ]);
    expect(result.json().status).toBe('healthy');
    expect(result.body).not.toContain('private-alpha');
    expect(result.body).not.toContain('private-beta');
  });

  it('documents bearer authentication for diagnostics and public liveness', async () => {
    const result = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(result.statusCode).toBe(200);
    const paths = result.json().paths;
    expect(paths['/api/health/diagnostics'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(paths['/api/health'].get.security).toEqual([]);
  });

  it('preserves existing loopback development no-auth administrative diagnostics', async () => {
    const previous = process.env['NODE_ENV'];
    delete process.env['NODE_ENV'];
    let local: FastifyInstance | undefined;
    try {
      local = buildApp({ db, silent: true, bindHost: '127.0.0.1' });
      await local.ready();
      const result = await local.inject({ method: 'GET', url: '/api/health/diagnostics' });
      expect(result.statusCode).toBe(200);
      expect(result.json().policyDormancy).toHaveLength(2);
    } finally {
      await local?.close();
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });

  it('requires authentication for diagnostics', async () => {
    const result = await app.inject({ method: 'GET', url: '/api/health/diagnostics' });
    expect(result.statusCode).toBe(401);
  });

  it.each([
    ['fixture-member', ''],
    ['fixture-tenant-admin', ''],
    ['fixture-tenant-admin', '?tenantId=private-alpha'],
    ['fixture-tenant-admin', '?tenantId=private-beta'],
    ['fixture-multi-admin', '?tenantId=private-alpha'],
  ])('refuses global diagnostics to %s with %s', async (token, query) => {
    const result = await app.inject({
      method: 'GET',
      url: `/api/health/diagnostics${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toContain('Private policy');
    expect(result.body).not.toContain('dormantRuleTypes');
  });

  it('preserves full operational diagnostics for an unscoped admin', async () => {
    const result = await app.inject({
      method: 'GET',
      url: '/api/health/diagnostics',
      headers: { authorization: 'Bearer fixture-global-admin' },
    });
    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.policyDormancy.map((row: { tenantId: string }) => row.tenantId).sort()).toEqual([
      'private-alpha',
      'private-beta',
    ]);
    expect(
      body.policyDormancy.every((row: { dormantRuleTypes: string[] }) =>
        row.dormantRuleTypes.includes('tenant_match'),
      ),
    ).toBe(true);
    expect(body.indexStalenessSeconds).toBeNull();
  });
});
