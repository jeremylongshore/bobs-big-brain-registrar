/**
 * Write-time provenance over the HTTP surface (GSB Wave-2 H1/H3).
 *
 * H3 — authorized-channel allowlist at intake: a capture CLAIMING an
 * unrecognized `origin.channel` gets a distinct 422 with the stable code
 * `unrecognized_channel`; allowed channels intake normally; origin-less
 * captures skip the check entirely (pre-H1 clients keep working).
 *
 * H1 — promotion-path verification: a forged origin token is refused at
 * `POST /api/candidates/:id/promote` with the stable code
 * `origin_token_invalid`; a validly-attested candidate promotes and its
 * receipt carries channel + a truncated token hash (H2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  CandidateRepository,
  AuditRepository,
} from '@qmd-team-intent-kb/store';
import { computeContentHash, hashOriginToken, mintOriginToken } from '@qmd-team-intent-kb/common';
import { makeAttestedCandidate, makeCandidate } from '@qmd-team-intent-kb/test-fixtures';
import { buildApp } from '../app.js';

const SECRET = 'a1'.repeat(32);
const WRONG_SECRET = 'b2'.repeat(32);
const TENANT = 'team-alpha';

describe('origin provenance over the API', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let candidateRepo: CandidateRepository;
  let auditRepo: AuditRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
    auditRepo = new AuditRepository(db);
    app = buildApp({ db, silent: true, originSecret: SECRET });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const intake = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/candidates', payload: payload as object });
  const promote = (id: string) =>
    app.inject({ method: 'POST', url: `/api/candidates/${id}/promote?tenantId=${TENANT}` });

  describe('H3 — channel allowlist at intake', () => {
    it('422s an unrecognized origin channel with the stable code unrecognized_channel', async () => {
      const candidate = makeAttestedCandidate(SECRET, {}, 'rogue-channel');
      const res = await intake(candidate);
      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string; code?: string };
      expect(body.code).toBe('unrecognized_channel');
      expect(body.error).toContain('rogue-channel');
      // Nothing was written.
      expect(candidateRepo.findById(candidate.id)).toBeNull();
    });

    it('accepts a capture claiming an allowed channel (default allowlist)', async () => {
      const candidate = makeAttestedCandidate(SECRET, {}, 'team-mcp');
      const res = await intake(candidate);
      expect(res.statusCode).toBe(201);
      expect(candidateRepo.findById(candidate.id)?.origin?.channel).toBe('team-mcp');
    });

    it('respects a deployment-supplied allowlist override', async () => {
      const custom = buildApp({
        db,
        silent: true,
        originSecret: SECRET,
        allowedChannels: ['ci-import'],
      });
      await custom.ready();
      try {
        const allowed = makeAttestedCandidate(SECRET, {}, 'ci-import');
        const denied = makeAttestedCandidate(SECRET, {}, 'team-mcp');
        const okRes = await custom.inject({
          method: 'POST',
          url: '/api/candidates',
          payload: allowed,
        });
        const badRes = await custom.inject({
          method: 'POST',
          url: '/api/candidates',
          payload: denied,
        });
        expect(okRes.statusCode).toBe(201);
        expect(badRes.statusCode).toBe(422);
        expect((badRes.json() as { code?: string }).code).toBe('unrecognized_channel');
      } finally {
        await custom.close();
      }
    });

    it('a legacy origin-less capture skips the channel check entirely', async () => {
      const legacy = makeCandidate();
      const res = await intake(legacy);
      expect(res.statusCode).toBe(201);
      expect(candidateRepo.findById(legacy.id)?.origin).toBeUndefined();
    });
  });

  describe('H1 — origin verification before promotion', () => {
    it('refuses a FORGED origin token with the stable code origin_token_invalid, leaving the candidate in the inbox', async () => {
      const forged = makeAttestedCandidate(WRONG_SECRET, {}, 'team-mcp');
      // Intake accepts it (channel is allowed; the HMAC is only verifiable at
      // the govern path, which holds the secret) …
      expect((await intake(forged)).statusCode).toBe(201);
      // … but promotion refuses it.
      const res = await promote(forged.id);
      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string; code?: string };
      expect(body.code).toBe('origin_token_invalid');
      // Left in the inbox for review; never promoted.
      expect(candidateRepo.findById(forged.id)?.status).toBe('inbox');
    });

    it('promotes a validly-attested candidate and receipts channel + truncated token hash (H2)', async () => {
      const attested = makeAttestedCandidate(SECRET, {}, 'team-mcp');
      expect((await intake(attested)).statusCode).toBe(201);
      const res = await promote(attested.id);
      expect(res.statusCode).toBe(200);
      const memory = res.json() as { id: string };

      const promoted = auditRepo.findByMemory(memory.id).find((e) => e.action === 'promoted');
      expect(promoted?.details['originChannel']).toBe('team-mcp');
      expect(promoted?.details['originTokenHash']).toBe(
        hashOriginToken(attested.origin!.tokenHmac).slice(0, 16),
      );
      // The receipt never carries the token itself.
      expect(JSON.stringify(promoted)).not.toContain(attested.origin!.tokenHmac);
    });

    it('refuses an attested candidate as unverifiable when the server has no origin secret (fail-closed)', async () => {
      const bare = buildApp({ db, silent: true }); // no originSecret
      await bare.ready();
      try {
        const attested = makeAttestedCandidate(SECRET, {}, 'team-mcp');
        candidateRepo.insert(attested, computeContentHash(attested.content));
        const res = await bare.inject({
          method: 'POST',
          url: `/api/candidates/${attested.id}/promote?tenantId=${TENANT}`,
        });
        expect(res.statusCode).toBe(422);
        expect((res.json() as { code?: string }).code).toBe('origin_token_unverifiable');
      } finally {
        await bare.close();
      }
    });

    it('sanity: the fixture really mints over (id, tenantId, capturedAt)', () => {
      const attested = makeAttestedCandidate(SECRET);
      expect(attested.origin?.tokenHmac).toBe(
        mintOriginToken(SECRET, {
          candidateId: attested.id,
          tenantId: attested.tenantId,
          capturedAt: attested.capturedAt,
        }),
      );
    });
  });
});
