import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  CandidateRepository,
  AuditRepository,
} from '@qmd-team-intent-kb/store';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { buildApp } from '../app.js';
import { applyIntakeOverrides } from '../services/candidate-service.js';
import { makeCandidate } from './fixtures.js';

/**
 * R8 — server-side candidate-intake override (Gate-1 of the 6-engineer review;
 * bead compile-then-govern-jfv.6.7).
 *
 * THE GAP: in team mode the CLIENT builds the entire `MemoryCandidate` and the
 * server used to `safeParse` and trust it. A member (or a leaked member token)
 * could assert `trustLevel:'high'`, forge `author`, name a foreign `tenantId`,
 * and pre-clear `prePolicyFlags.potentialSecret:false` — and intake wrote NO
 * provenance receipt. These tests prove the server now OWNS those fields and
 * stamps a receipt + quarantine marker on every proposal.
 */
describe('R8 — candidate intake server-side override', () => {
  // ---- pure override logic (guard-independent) ---------------------------
  //
  // The HTTP tenancy guard rejects a SCOPED token's out-of-allowlist tenantId
  // with 403 before intake runs, so these unit tests exercise the intake binding
  // directly: they prove that even a forged foreign tenantId reaching the service
  // is neutralized to the token's own tenant.
  describe('applyIntakeOverrides', () => {
    const forged = () =>
      makeCandidate({
        trustLevel: 'high',
        author: { type: 'ai', id: 'governed-brain' },
        tenantId: 'attacker-tenant',
        prePolicyFlags: { potentialSecret: false, lowConfidence: true, duplicateSuspect: true },
        metadata: { filePaths: [], tags: ['x'] },
      });

    it('forces a MEMBER proposal to server-owned trust / author / tenant / flags / marker', () => {
      const out = applyIntakeOverrides(forged(), {
        actor: 'mia',
        role: 'member',
        tenants: ['team-secure'],
      });

      // trustLevel forced to the lowest enum — the asserted 'high' is dropped.
      expect(out.trustLevel).toBe('untrusted');
      // author is the token identity, not the client's hardcoded 'governed-brain'.
      expect(out.author).toEqual({ type: 'human', id: 'mia' });
      // tenantId bound to the token's sole tenant, overriding the forged 'attacker-tenant'.
      expect(out.tenantId).toBe('team-secure');
      // prePolicyFlags reset to server defaults — the client's true flags are dropped.
      expect(out.prePolicyFlags).toEqual({
        potentialSecret: false,
        lowConfidence: false,
        duplicateSuspect: false,
      });
      // quarantine marker stamped for B1.
      expect(out.metadata.proposedByRole).toBe('member');
    });

    it('preserves an ADMIN’s asserted trust but still stamps identity, tenant, and marker', () => {
      const out = applyIntakeOverrides(forged(), {
        actor: 'adam',
        role: 'admin',
        tenants: ['team-secure'],
      });
      // admin keeps the asserted level (only member is forced low).
      expect(out.trustLevel).toBe('high');
      expect(out.author).toEqual({ type: 'human', id: 'adam' });
      expect(out.tenantId).toBe('team-secure');
      expect(out.prePolicyFlags.lowConfidence).toBe(false);
      expect(out.metadata.proposedByRole).toBe('admin');
    });

    it('a scoped-multi token keeps the (guard-validated) supplied tenantId', () => {
      const cand = makeCandidate({ tenantId: 'team-a' });
      const out = applyIntakeOverrides(cand, {
        actor: 'mo',
        role: 'admin',
        tenants: ['team-a', 'team-b'],
      });
      // Multi-tenant scope: the tenancy guard already validated 'team-a' is in the
      // allowlist, so intake leaves it — it does not guess a single binding.
      expect(out.tenantId).toBe('team-a');
    });

    it('an empty context (dev / direct intake) resets only the never-trusted flags', () => {
      const cand = makeCandidate({
        trustLevel: 'high',
        author: { type: 'ai', id: 'claude-x' },
        tenantId: 'team-x',
        prePolicyFlags: { potentialSecret: false, lowConfidence: true, duplicateSuspect: true },
      });
      const out = applyIntakeOverrides(cand, {});
      // No token identity → author / trust / tenant left as parsed …
      expect(out.author).toEqual({ type: 'ai', id: 'claude-x' });
      expect(out.trustLevel).toBe('high');
      expect(out.tenantId).toBe('team-x');
      // … but prePolicyFlags are ALWAYS server-owned, and no marker is stamped.
      expect(out.prePolicyFlags).toEqual({
        potentialSecret: false,
        lowConfidence: false,
        duplicateSuspect: false,
      });
      expect(out.metadata.proposedByRole).toBeUndefined();
    });

    it('returns a structurally valid MemoryCandidate (re-parsed)', () => {
      const out = applyIntakeOverrides(forged(), {
        actor: 'mia',
        role: 'member',
        tenants: ['team-secure'],
      });
      // Round-trips through the schema without throwing.
      expect(() => MemoryCandidate.parse(out)).not.toThrow();
    });
  });

  // ---- HTTP intake with per-user tokens -----------------------------------
  describe('POST /api/candidates (authenticated)', () => {
    const MEMBER = 'mia-member-token';
    const ADMIN = 'adam-admin-token';

    let db: Database.Database;
    let app: FastifyInstance;
    let candidateRepo: CandidateRepository;
    let auditRepo: AuditRepository;

    beforeEach(async () => {
      db = createTestDatabase();
      candidateRepo = new CandidateRepository(db);
      auditRepo = new AuditRepository(db);
      app = buildApp({
        db,
        silent: true,
        tokens: [
          { token: MEMBER, actor: 'mia', role: 'member', tenants: ['team-secure'] },
          { token: ADMIN, actor: 'adam', role: 'admin', tenants: ['team-secure'] },
        ],
      });
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
      db.close();
    });

    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

    it('neutralizes a MEMBER’s forged trust / author / flags and stamps the receipt + marker', async () => {
      const content = 'Use exponential backoff with jitter on the retry path.';
      const id = randomUUID();
      const res = await app.inject({
        method: 'POST',
        url: '/api/candidates',
        headers: auth(MEMBER),
        payload: {
          id,
          status: 'inbox',
          source: 'mcp',
          content,
          title: 'Retry backoff convention',
          category: 'convention',
          // ── all four forged, trust-bearing fields ──
          trustLevel: 'high',
          author: { type: 'ai', id: 'governed-brain' },
          tenantId: 'team-secure',
          prePolicyFlags: { potentialSecret: false, lowConfidence: true, duplicateSuspect: true },
          metadata: { filePaths: [], tags: ['retry'] },
          capturedAt: new Date().toISOString(),
        },
      });
      expect(res.statusCode).toBe(201);

      // The STORED candidate is fully server-owned.
      const stored = candidateRepo.findById(id);
      expect(stored).not.toBeNull();
      expect(stored!.trustLevel).toBe('untrusted'); // server-forced low
      expect(stored!.author).toEqual({ type: 'human', id: 'mia' }); // token identity
      expect(stored!.tenantId).toBe('team-secure'); // bound to the token
      expect(stored!.prePolicyFlags).toEqual({
        potentialSecret: false,
        lowConfidence: false,
        duplicateSuspect: false,
      }); // recomputed/reset
      expect(stored!.metadata.proposedByRole).toBe('member'); // quarantine marker

      // An intake receipt was written, anchored to the actor + candidate.
      const receipts = auditRepo.findByTenantAndAction('team-secure', 'proposed');
      expect(receipts).toHaveLength(1);
      const receipt = receipts[0]!;
      expect(receipt.memoryId).toBe(id);
      expect(receipt.actor).toEqual({ type: 'human', id: 'mia' });
      const details = receipt.details as Record<string, unknown>;
      expect(details['candidateId']).toBe(id);
      expect(details['contentHash']).toBe(computeContentHash(content));
      expect(details['tenantId']).toBe('team-secure');
      expect(details['proposedByRole']).toBe('member');
    });

    it('rejects a MEMBER naming a FOREIGN tenant (403, tenancy guard) — nothing stored', async () => {
      const id = randomUUID();
      const res = await app.inject({
        method: 'POST',
        url: '/api/candidates',
        headers: auth(MEMBER),
        payload: makeCandidate({ id, tenantId: 'attacker-tenant' }),
      });
      expect(res.statusCode).toBe(403);
      expect(candidateRepo.findById(id)).toBeNull();
      expect(auditRepo.findByTenantAndAction('attacker-tenant', 'proposed')).toHaveLength(0);
    });

    it('an ADMIN keeps its asserted trust, is stamped as author, and marked admin', async () => {
      const id = randomUUID();
      const res = await app.inject({
        method: 'POST',
        url: '/api/candidates',
        headers: auth(ADMIN),
        payload: makeCandidate({
          id,
          tenantId: 'team-secure',
          trustLevel: 'high',
          author: { type: 'ai', id: 'governed-brain' },
        }),
      });
      expect(res.statusCode).toBe(201);

      const stored = candidateRepo.findById(id);
      expect(stored!.trustLevel).toBe('high'); // admin level preserved
      expect(stored!.author).toEqual({ type: 'human', id: 'adam' }); // stamped
      expect(stored!.metadata.proposedByRole).toBe('admin'); // marker

      const receipts = auditRepo.findByTenantAndAction('team-secure', 'proposed');
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.actor).toEqual({ type: 'human', id: 'adam' });
    });
  });

  // ---- dev no-auth path still writes a receipt (back-compat) ---------------
  describe('POST /api/candidates (dev no-auth)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let candidateRepo: CandidateRepository;
    let auditRepo: AuditRepository;

    beforeEach(async () => {
      db = createTestDatabase();
      candidateRepo = new CandidateRepository(db);
      auditRepo = new AuditRepository(db);
      app = buildApp({ db, silent: true }); // empty registry → dev admin
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
      db.close();
    });

    it('stamps the dev actor + admin marker and writes an intake receipt', async () => {
      const id = randomUUID();
      const res = await app.inject({
        method: 'POST',
        url: '/api/candidates',
        payload: makeCandidate({ id, tenantId: 'team-dev', trustLevel: 'high' }),
      });
      expect(res.statusCode).toBe(201);

      const stored = candidateRepo.findById(id);
      expect(stored!.author).toEqual({ type: 'human', id: 'dev' });
      expect(stored!.trustLevel).toBe('high'); // dev runs as admin — level kept
      expect(stored!.metadata.proposedByRole).toBe('admin');

      const receipts = auditRepo.findByTenantAndAction('team-dev', 'proposed');
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.actor).toEqual({ type: 'human', id: 'dev' });
    });
  });
});
