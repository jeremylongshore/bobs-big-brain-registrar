/**
 * Write-time provenance gate (GSB Wave-2 H1) — unit verdicts for
 * `checkOriginAttestation` plus the Curator integration: a forged/unverifiable
 * origin claim is REJECTED with a receipted, policy-pipeline-shaped result;
 * an unattested legacy candidate still governs; a valid attestation promotes
 * and its 'promoted' receipt carries channel + truncated token hash (H2).
 */
import type Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';
import { hashOriginToken, mintOriginToken } from '@qmd-team-intent-kb/common';
import {
  createTestDatabase,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
} from '@qmd-team-intent-kb/store';
import { makeAttestedCandidate, makeCandidate, TENANT } from './fixtures.js';
import { checkOriginAttestation } from '../origin/origin-gate.js';
import { Curator } from '../curator.js';

const SECRET = 'a1'.repeat(32);
const WRONG_SECRET = 'b2'.repeat(32);

describe('checkOriginAttestation — verdict table', () => {
  it('no origin → unattested (accepted for backward compatibility)', () => {
    expect(checkOriginAttestation(makeCandidate(), SECRET)).toEqual({ verdict: 'unattested' });
    // Even with no secret configured, an unattested candidate is not rejected.
    expect(checkOriginAttestation(makeCandidate(), undefined)).toEqual({ verdict: 'unattested' });
  });

  it('valid origin under the installation secret → attested', () => {
    const candidate = makeAttestedCandidate(SECRET);
    expect(checkOriginAttestation(candidate, SECRET)).toEqual({ verdict: 'attested' });
  });

  it('forged origin (minted under a different secret) → rejected origin_token_invalid', () => {
    const candidate = makeAttestedCandidate(WRONG_SECRET);
    const res = checkOriginAttestation(candidate, SECRET);
    expect(res.verdict).toBe('rejected');
    if (res.verdict === 'rejected') {
      expect(res.code).toBe('origin_token_invalid');
      expect(res.pipelineResult.outcome).toBe('rejected');
      expect(res.pipelineResult.rejectedBy).toBe('origin_token_invalid');
      expect(res.pipelineResult.evaluations[0]?.ruleType).toBe('origin_attestation');
    }
  });

  it('valid token replayed onto a different identity → rejected origin_token_invalid', () => {
    const original = makeAttestedCandidate(SECRET);
    // Replay the token onto a candidate with a different id/capturedAt.
    const replayed = makeCandidate({ origin: original.origin });
    const res = checkOriginAttestation(replayed, SECRET);
    expect(res.verdict).toBe('rejected');
    if (res.verdict === 'rejected') expect(res.code).toBe('origin_token_invalid');
  });

  it('origin claimed but no secret configured → rejected origin_token_unverifiable (fail-closed)', () => {
    const candidate = makeAttestedCandidate(SECRET);
    const res = checkOriginAttestation(candidate, undefined);
    expect(res.verdict).toBe('rejected');
    if (res.verdict === 'rejected') expect(res.code).toBe('origin_token_unverifiable');
  });
});

describe('Curator integration — origin gate on the promotion path', () => {
  let db: Database.Database;
  let candidateRepo: CandidateRepository;
  let memoryRepo: MemoryRepository;
  let policyRepo: PolicyRepository;
  let auditRepo: AuditRepository;

  beforeEach(() => {
    db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
    memoryRepo = new MemoryRepository(db);
    policyRepo = new PolicyRepository(db);
    auditRepo = new AuditRepository(db);
  });

  function curator(originSecret?: string): Curator {
    return new Curator(
      { candidateRepo, memoryRepo, policyRepo, auditRepo },
      { tenantId: TENANT, originSecret },
    );
  }

  it('REJECTS a forged origin before promotion, with a receipted reject naming origin_token_invalid', () => {
    const forged = makeAttestedCandidate(WRONG_SECRET);
    const result = curator(SECRET).processSingle(forged);

    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain('origin_token_invalid');
    expect(memoryRepo.findByTenant(TENANT)).toHaveLength(0);

    // The rejection receipt is on the chain (curator default path — receipts on).
    const receipts = auditRepo.findByMemory(forged.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reason).toContain('origin_token_invalid');
  });

  it('still governs an unattested legacy candidate, receipting its promotion as channel=unattested (H2)', () => {
    const legacy = makeCandidate();
    const result = curator(SECRET).processSingle(legacy);

    expect(result.outcome).toBe('promoted');
    const promoted = auditRepo
      .findByMemory(result.memoryId ?? '')
      .find((e) => e.action === 'promoted');
    expect(promoted?.details['originChannel']).toBe('unattested');
    expect(promoted?.details['originTokenHash']).toBeUndefined();
  });

  it('promotes a validly-attested candidate and receipts channel + TRUNCATED token hash, never the token (H2)', () => {
    const attested = makeAttestedCandidate(SECRET);
    const result = curator(SECRET).processSingle(attested);

    expect(result.outcome).toBe('promoted');
    const promoted = auditRepo
      .findByMemory(result.memoryId ?? '')
      .find((e) => e.action === 'promoted');
    expect(promoted?.details['originChannel']).toBe('local-mcp');
    const surfaced = promoted?.details['originTokenHash'];
    expect(surfaced).toBe(hashOriginToken(attested.origin!.tokenHmac).slice(0, 16));
    // Never enough to replay-mint: not the token, not even its full hash.
    expect(surfaced).not.toBe(attested.origin!.tokenHmac);
    expect(String(surfaced)).toHaveLength(16);
  });

  it('rejects an attested candidate as unverifiable when the govern path has no secret (fail-closed)', () => {
    const attested = makeAttestedCandidate(SECRET);
    const result = curator(undefined).processSingle(attested);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain('origin_token_unverifiable');
    expect(memoryRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('round-trips origin through the candidates store (persisted claim, verified at govern time)', () => {
    const attested = makeAttestedCandidate(SECRET);
    candidateRepo.insert(attested, 'c'.repeat(64));
    const readBack = candidateRepo.findById(attested.id);
    expect(readBack?.origin).toEqual(attested.origin);
    // A legacy row without origin reads back with origin undefined.
    const legacy = makeCandidate();
    candidateRepo.insert(legacy, 'd'.repeat(64));
    expect(candidateRepo.findById(legacy.id)?.origin).toBeUndefined();
    // Sanity: the token really was minted from identity fields.
    expect(attested.origin?.tokenHmac).toBe(
      mintOriginToken(SECRET, {
        candidateId: attested.id,
        tenantId: attested.tenantId,
        capturedAt: attested.capturedAt,
      }),
    );
  });
});
