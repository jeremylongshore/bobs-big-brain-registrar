import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  PolicyRepository,
  IndexStateRepository,
  MemoryRepository,
} from '@qmd-team-intent-kb/store';
import { buildRecommendedPolicy } from '@qmd-team-intent-kb/policy-engine';
import type { PolicyRule } from '@qmd-team-intent-kb/schema';
import { buildApp } from '../app.js';
import { makeMemory } from './fixtures.js';

const NOW = '2026-07-17T00:00:00.000Z';

describe('GET /api/health', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDatabase();
    app = buildApp({ db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns status healthy when the database is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('healthy');
  });

  it('returns a non-negative uptime in seconds', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const body = res.json<{ uptime: number }>();
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns the current API version', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const body = res.json<{ version: string }>();
    expect(body.version).toBe('0.4.0');
  });

  // ─── Policy dormancy surfacing (5bm.10) ────────────────────────────────────

  it('reports no policy dormancy when no policy exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json<{ policyDormancy: unknown[] }>().policyDormancy).toEqual([]);
  });

  it('reports zero dormancy for the complete recommended policy', async () => {
    new PolicyRepository(db).insert(buildRecommendedPolicy('acme', NOW));
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json<{ policyDormancy: unknown[] }>().policyDormancy).toEqual([]);
    expect(res.statusCode).toBe(200); // dormancy never degrades liveness
  });

  it('lists the dormant rule types for an incomplete enabled policy', async () => {
    // Only two rules enabled — the shape of the pre-5bm.2 live policy.
    const partial = buildRecommendedPolicy('acme', NOW);
    const twoRules = partial.rules.filter(
      (r: PolicyRule) => r.type === 'secret_detection' || r.type === 'content_length',
    );
    new PolicyRepository(db).insert({ ...partial, rules: twoRules });

    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const body = res.json<{
      status: string;
      policyDormancy: Array<{ policyName: string; dormantRuleTypes: string[] }>;
    }>();
    expect(res.statusCode).toBe(200);
    expect(body.status).toBe('healthy'); // still live
    expect(body.policyDormancy).toHaveLength(1);
    // The six uncovered registered rule types are named.
    expect(body.policyDormancy[0]!.dormantRuleTypes).toEqual(
      expect.arrayContaining([
        'tenant_match',
        'source_trust',
        'relevance_score',
        'sensitivity_gate',
        'dedup_check',
        'content_sanitization',
      ]),
    );
    expect(body.policyDormancy[0]!.dormantRuleTypes).not.toContain('secret_detection');
  });

  it('ignores a disabled policy for dormancy', async () => {
    const partial = buildRecommendedPolicy('acme', NOW);
    new PolicyRepository(db).insert({ ...partial, rules: [], enabled: false });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json<{ policyDormancy: unknown[] }>().policyDormancy).toEqual([]);
  });

  // ─── Index staleness surfacing (D2) ────────────────────────────────────────

  it('reports indexStalenessSeconds null before measurement starts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json<{ indexStalenessSeconds: number | null }>().indexStalenessSeconds).toBeNull();
  });

  it('reports 0 staleness when the index has absorbed every promotion', async () => {
    new IndexStateRepository(db).markIndexed('acme', NOW);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json<{ indexStalenessSeconds: number | null }>().indexStalenessSeconds).toBe(0);
  });

  it('reports positive staleness when a promotion post-dates the last index run — never degrading liveness', async () => {
    new IndexStateRepository(db).markIndexed('acme', NOW);
    // A promotion 1ms after the last index run → measured stale.
    new MemoryRepository(db).insert(
      makeMemory({ tenantId: 'acme', promotedAt: '2026-07-17T00:00:00.001Z' }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const body = res.json<{ status: string; indexStalenessSeconds: number | null }>();
    expect(body.indexStalenessSeconds).toBeGreaterThan(0);
    expect(body.status).toBe('healthy'); // staleness is an operator signal, not an outage
    expect(res.statusCode).toBe(200);
  });
});
