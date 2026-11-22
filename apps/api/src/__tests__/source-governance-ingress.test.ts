import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createTestDatabase,
  CandidateRepository,
  MemoryRepository,
  AuditRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { buildApp, type AppDependencies } from '../app.js';
import { makeSourceGovernanceFixture } from '../../../curator/src/__tests__/source-governance-fixtures.js';
import { signSourceClassification } from '../../../curator/src/origin/source-classification-codec.js';

let db: ReturnType<typeof createTestDatabase>;
let app: FastifyInstance;
let f: ReturnType<typeof makeSourceGovernanceFixture>;
let now: string;
const tokens = [
  { token: 'synthetic-admin', actor: 'reviewer', role: 'admin' as const, tenants: ['synthetic'] },
  { token: 'synthetic-member', actor: 'proposer', role: 'member' as const, tenants: ['synthetic'] },
  { token: 'other-admin', actor: 'other-reviewer', role: 'admin' as const, tenants: ['other'] },
];
function storeRegistry() {
  db.prepare('INSERT OR REPLACE INTO source_classification_authority VALUES (1, ?)').run(
    JSON.stringify(f.registry),
  );
}
async function start(overrides: Partial<AppDependencies> = {}) {
  app = buildApp({
    db,
    silent: true,
    tokens: [tokens[0]!],
    rateLimitMax: 1000,
    sourceGovernance: { receiverId: 'registrar', now: () => now },
    ...overrides,
  });
  await app.ready();
}
async function request(payload: unknown, token = 'synthetic-admin', id = f.candidate.id) {
  return app.inject({
    method: 'POST',
    url: `/api/candidates/${id}/source-governance`,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as object,
  });
}
function envelope(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    tenantId: 'synthetic',
    action: 'preview',
    assertion: signSourceClassification(f.payload, f.keys.privateKey),
    ...extra,
  };
}
async function intake(token = 'synthetic-admin', extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/candidates',
    headers: { authorization: `Bearer ${token}` },
    payload: { ...f.candidate, ...extra },
  });
}
beforeEach(async () => {
  db = createTestDatabase();
  f = makeSourceGovernanceFixture();
  now = f.receiver.now;
  f.registry.enrollments[0]!.ingressId = 'api-source-governance-v1';
  storeRegistry();
  await start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  db.close();
});

describe('authenticated source governance HTTP ingress', () => {
  it('intakes canonically, previews without writes, applies source floor and settles replay', async () => {
    const captured = await intake();
    expect(captured.statusCode).toBe(201);
    expect(captured.json().author.id).toBe('reviewer');
    const before = db.serialize().toString('base64');
    const preview = await request(envelope());
    expect(preview.statusCode).toBe(200);
    expect(db.serialize().toString('base64')).toBe(before);
    const body = envelope({ action: 'apply', plan: preview.json().plan });
    const applied = await request(body);
    expect(applied.statusCode).toBe(200);
    expect(applied.json().settlement.outcome).toBe('promoted');
    expect(new MemoryRepository(db).findByTenant('synthetic')[0]?.sensitivity).toBe('confidential');
    const settled = db.serialize().toString('base64');
    expect((await request(body)).json().alreadySettled).toBe(true);
    expect(db.serialize().toString('base64')).toBe(settled);
    expect(verifyAuditChain(new AuditRepository(db)).breaks).toEqual([]);
  });
  it.each(['missing', 'wrong', 'synthetic-member', 'other-admin'])(
    'refuses %s credentials without writes',
    async (token) => {
      await app.close();
      await start({ tokens });
      await intake();
      const before = db.serialize().toString('base64');
      expect((await request(envelope(), token)).statusCode).toBe(
        token === 'synthetic-member' || token === 'other-admin' ? 403 : 401,
      );
      expect(db.serialize().toString('base64')).toBe(before);
    },
  );
  it('does not accept the loopback dev admin as authenticated evidence authority', async () => {
    await app.close();
    await start({ tokens: [] });
    const res = await app.inject({
      method: 'POST',
      url: `/api/candidates/${f.candidate.id}/source-governance`,
      payload: envelope(),
    });
    expect(res.statusCode).toBe(403);
  });
  it.each([
    { version: 2 },
    { assertion: undefined },
    { receiverId: 'caller' },
    { now: 'caller' },
    { ingressId: 'api' },
    { profileId: 'caller' },
    { actor: 'owner' },
  ])('refuses malformed/authority-selecting envelopes %j', async (extra) => {
    await intake();
    const before = db.serialize().toString('base64');
    // A string clock is enough to demonstrate it cannot be request-selected.
    const res = await request(
      envelope({
        ...extra,
        ...(Object.hasOwn(extra, 'now') ? { now: '2026-11-22T09:02:00.000Z' } : {}),
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(db.serialize().toString('base64')).toBe(before);
  });
  it.each(['forged', 'expired', 'revoked', 'wrong-route', 'wrong-receiver'])(
    'refuses %s evidence without writes',
    async (kind) => {
      await intake();
      const body = envelope();
      if (kind === 'forged')
        body.assertion = body.assertion.replace(
          /"signature":"([a-f0-9])/,
          (_match, digit: string) => '"signature":"' + (digit === '0' ? '1' : '0'),
        );
      if (kind === 'expired') now = f.payload.expiresAt;
      if (kind === 'revoked') {
        f.registry.keys[0]!.revoked = true;
        storeRegistry();
      }
      if (kind === 'wrong-route') {
        f.registry.enrollments[0]!.ingressId = 'api';
        storeRegistry();
      }
      if (kind === 'wrong-receiver') {
        await app.close();
        await start({ sourceGovernance: { receiverId: 'other', now: () => now } });
      }
      const before = db.serialize().toString('base64');
      expect((await request(body)).statusCode).toBe(409);
      expect(db.serialize().toString('base64')).toBe(before);
    },
  );
  it('rechecks revocation between preview and apply', async () => {
    await intake();
    const preview = await request(envelope());
    f.registry.keys[0]!.revoked = true;
    storeRegistry();
    const before = db.serialize().toString('base64');
    expect(
      (await request(envelope({ action: 'apply', plan: preview.json().plan }))).statusCode,
    ).toBe(409);
    expect(db.serialize().toString('base64')).toBe(before);
  });
  it('preserves member quarantine even when an admin supplies valid source evidence', async () => {
    await app.close();
    await start({ tokens: tokens.slice(0, 2) });
    expect((await intake('synthetic-member')).statusCode).toBe(201);
    const preview = await request(envelope());
    expect(preview.statusCode).toBe(200);
    const applied = await request(envelope({ action: 'apply', plan: preview.json().plan }));
    expect(applied.json().settlement.outcome).toBe('quarantined');
    expect(new CandidateRepository(db).findById(f.candidate.id)?.status).toBe('quarantined');
    expect(new MemoryRepository(db).findByTenant('synthetic')).toHaveLength(0);
  });
  it.each(['sourceEvidence', 'sourceAssertion', 'sourceClassification', 'assertion'])(
    'rejects reserved %s on legacy intake instead of stripping it',
    async (field) => {
      const result = await intake('synthetic-admin', { [field]: envelope().assertion });
      expect(result.statusCode).toBe(422);
      expect(result.json().code).toBe('source_evidence_unsupported');
      expect(new CandidateRepository(db).findById(f.candidate.id)).toBeNull();
    },
  );
  it('returns an actionable refusal for legacy promotion of a required tenant', async () => {
    await intake();
    const result = await app.inject({
      method: 'POST',
      url: `/api/candidates/${f.candidate.id}/promote?tenantId=synthetic`,
      headers: { authorization: 'Bearer synthetic-admin' },
      payload: {},
    });
    expect(result.statusCode).toBe(422);
    expect(result.json().code).toBe('SOURCE_ENROLLMENT_REQUIRED');
    expect(new MemoryRepository(db).findByTenant('synthetic')).toHaveLength(0);
  });
  it('does not transfer evidence when canonical intake collapses to another ID', async () => {
    const original = '33333333-3333-4333-8333-333333333333';
    expect((await intake('synthetic-admin', { id: original })).statusCode).toBe(201);
    const collapsed = await intake();
    expect(collapsed.statusCode).toBe(200);
    expect(collapsed.json().id).toBe(original);
    expect((await request(envelope())).statusCode).toBe(404);
    expect((await request(envelope(), 'synthetic-admin', original)).statusCode).toBe(409);
    expect(new MemoryRepository(db).findByTenant('synthetic')).toHaveLength(0);
  });
  it('advertises disabled ingress and refuses until server configuration exists', async () => {
    await intake();
    await app.close();
    await start({ sourceGovernance: undefined });
    const cap = await app.inject({
      method: 'GET',
      url: '/api/candidates/source-governance-capabilities?tenantId=synthetic',
      headers: { authorization: 'Bearer synthetic-admin' },
    });
    expect(cap.statusCode).toBe(200);
    expect(cap.json().enabled).toBe(false);
    expect((await request(envelope())).statusCode).toBe(503);
  });
  it('scopes discovery to the authorized tenant and current matching enrollment', async () => {
    await app.close();
    await start({ tokens });
    const discover = (token = 'synthetic-admin') =>
      app.inject({
        method: 'GET',
        url: '/api/candidates/source-governance-capabilities?tenantId=synthetic',
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await discover('other-admin')).statusCode).toBe(403);
    expect((await discover()).json()).toMatchObject({
      enabled: true,
      configured: true,
      enrolled: true,
    });
    f.registry.enrollments[0]!.ingressId = 'other-ingress';
    storeRegistry();
    expect((await discover()).json()).toMatchObject({
      enabled: false,
      configured: true,
      enrolled: false,
    });
    db.prepare('DELETE FROM source_classification_authority').run();
    expect((await discover()).json().enabled).toBe(false);
  });
  it('preserves unenrolled legacy promotion', async () => {
    db.prepare('DELETE FROM source_classification_authority').run();
    await intake();
    const result = await app.inject({
      method: 'POST',
      url: `/api/candidates/${f.candidate.id}/promote?tenantId=synthetic`,
      headers: { authorization: 'Bearer synthetic-admin' },
      payload: {},
    });
    expect(result.statusCode).toBe(200);
  });
  it('enforces the independent disclosure floor with no enabled policy', async () => {
    await intake();
    // Public AWS documentation example, deliberately credential-shaped to test the scanner.
    const content = 'deploy key AKIAIOSFODNN7EXAMPLE for the bucket';
    db.prepare('UPDATE candidates SET content = ? WHERE id = ?').run(content, f.candidate.id);
    const before = db.serialize().toString('base64');
    const result = await request(envelope());
    expect(result.statusCode).toBe(422);
    expect(result.json().code).toBe('source_disclosure_rejected');
    expect(result.body).not.toContain(content);
    expect(db.serialize().toString('base64')).toBe(before);
  });
  it('binds configured hold limits into the preview plan', async () => {
    const holdLimits = { ttlDays: 2, maxActiveHolds: 3 };
    await app.close();
    await start({ holdLimits });
    await intake();
    const preview = await request(envelope());
    expect(preview.statusCode).toBe(200);
    holdLimits.maxActiveHolds = 4;
    const before = db.serialize().toString('base64');
    expect(
      (await request(envelope({ action: 'apply', plan: preview.json().plan }))).statusCode,
    ).toBe(409);
    expect(db.serialize().toString('base64')).toBe(before);
  });
  it('rolls back if authentication expires during the governance transaction', async () => {
    await app.close();
    const realNow = Date.now();
    let expire = false;
    let applyReads = 0;
    await start({
      tokens: [{ ...tokens[0]!, expiresAt: new Date(realNow + 60000).toISOString() }],
      sourceGovernance: {
        receiverId: 'registrar',
        now: () => {
          if (expire && ++applyReads === 3) vi.spyOn(Date, 'now').mockReturnValue(realNow + 120000);
          return now;
        },
      },
    });
    await intake();
    const preview = await request(envelope());
    const before = db.serialize().toString('base64');
    expire = true;
    expect(
      (await request(envelope({ action: 'apply', plan: preview.json().plan }))).statusCode,
    ).toBe(403);
    expect(db.serialize().toString('base64')).toBe(before);
  });
  it('reports refresh failure after successful governance without undoing promotion', async () => {
    const refreshAfterPromotion = vi.fn(async () => {
      throw new Error('synthetic refresh failure');
    });
    await app.close();
    await start({ indexRefresher: { refreshAfterPromotion } });
    await intake();
    const preview = await request(envelope());
    const applied = await request(envelope({ action: 'apply', plan: preview.json().plan }));
    expect(applied.statusCode).toBe(200);
    expect(applied.json().indexRefresh).toBe('pending');
    expect(refreshAfterPromotion).toHaveBeenCalledWith('synthetic');
    expect(new MemoryRepository(db).findByTenant('synthetic')).toHaveLength(1);
  });
  it.each(['/api/import', '/api/import/preview'])(
    'refuses evidence on unsupported %s before accessing a source directory',
    async (url) => {
      const before = db.serialize().toString('base64');
      const result = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Bearer synthetic-admin' },
        payload: {
          tenantId: 'synthetic',
          sourcePath: '/not-a-real-source',
          assertion: 'synthetic-evidence',
        },
      });
      expect(result.statusCode).toBe(422);
      expect(result.json().code).toBe('source_evidence_unsupported');
      expect(db.serialize().toString('base64')).toBe(before);
    },
  );
});
