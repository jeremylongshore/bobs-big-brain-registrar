/**
 * Govern-at-merge gate (EPIC 1, bead compile-then-govern-8da.9).
 *
 * Proves the re-derivation-over-union pass re-governs EVERY merged row as
 * untrusted and never admits a row that would fail the front-door gate:
 *
 *   1. a secret-bearing and a disclosure-bearing row from one clone are
 *      QUARANTINED, not admitted;
 *   2. a row duplicated across both clones dedupes by content-derived id (one
 *      survives);
 *   3. commutativity - mergeGovern(A, B) and mergeGovern(B, A) produce
 *      byte-identical governed state AND an identical audit outcome;
 *   4. every surviving row provably passed the full gate (re-running the gate
 *      over the survivors admits all of them unchanged).
 *
 * @module __tests__/merge-gate.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  MemoryRepository,
  AuditRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { assertDisclosureClean, DisclosureRejectedError } from '@qmd-team-intent-kb/common';
import { PolicyPipeline } from '@qmd-team-intent-kb/policy-engine';
import { GovernancePolicy } from '@qmd-team-intent-kb/schema';
import type {
  CuratedMemory,
  GovernancePolicy as GovernancePolicyType,
} from '@qmd-team-intent-kb/schema';
import { mergeGovern } from '../merge/merge-gate.js';
import { MemoryCandidate as MemoryCandidateSchema } from '@qmd-team-intent-kb/schema';
import { makeCuratedMemory, TENANT, NOW } from './fixtures.js';

interface MergeDeps {
  memoryRepo: MemoryRepository;
  auditRepo: AuditRepository;
}

function makeDeps(db: Database.Database): MergeDeps {
  return {
    memoryRepo: new MemoryRepository(db),
    auditRepo: new AuditRepository(db),
  };
}

/**
 * A realistic merge policy. Because the merge gate downgrades every union row to
 * `untrusted`, the `source_trust` rule is configured to accept `untrusted` (the
 * merge re-govern explicitly trusts NO prior standing, so the policy must opt in
 * to admitting untrusted rows). The secret + length + dedupe rules still bite.
 */
function makeMergePolicy(overrides?: Partial<GovernancePolicyType>): GovernancePolicyType {
  return GovernancePolicy.parse({
    id: '00000000-0000-4000-8000-0000000000aa',
    name: 'Merge re-govern policy',
    tenantId: TENANT,
    rules: [
      {
        id: 'rule-secret-detect',
        type: 'secret_detection',
        action: 'reject',
        enabled: true,
        priority: 0,
        parameters: {},
      },
      {
        id: 'rule-dedup',
        type: 'dedup_check',
        action: 'reject',
        enabled: true,
        priority: 1,
        parameters: {},
      },
      {
        id: 'rule-length',
        type: 'content_length',
        action: 'reject',
        enabled: true,
        priority: 2,
        parameters: { min: 10, max: 50000 },
      },
      {
        id: 'rule-trust',
        type: 'source_trust',
        action: 'reject',
        enabled: true,
        priority: 3,
        parameters: { minimumTrust: 'untrusted' },
      },
    ],
    enabled: true,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

/**
 * Build a promoted CuratedMemory whose `id` is the content-derived id the merge
 * gate would re-derive - so that the same logical content yields the same id on
 * both "clones". We let the fixture mint random ids by default; for the
 * cross-clone-duplicate test we pin BOTH clones' rows to the same id + content.
 */
function makeRow(content: string, overrides?: Partial<CuratedMemory>): CuratedMemory {
  return makeCuratedMemory({ content, ...overrides });
}

/**
 * Secret literal, fragmented via string concatenation so the raw token never
 * appears as one literal in source. Once concatenated it is exactly `AKIA` + 16
 * uppercase-alnum chars, matching the disclosure scanner's AWS access-key pattern
 * `\bAKIA[0-9A-Z]{16}\b` so the disclosure choke point catches it.
 */
const SECRET_LITERAL = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';
/** Disclosure (PII) literal - matches the SSN pattern NNN-NN-NNNN. */
const SSN_LITERAL = '123' + '-45' + '-6789';

describe('mergeGovern - govern-at-merge gate', () => {
  let db: Database.Database;
  let deps: MergeDeps;

  beforeEach(() => {
    db = createTestDatabase();
    deps = makeDeps(db);
  });

  it('quarantines a secret-bearing and a disclosure-bearing row, admitting neither', () => {
    const policy = makeMergePolicy();

    const cleanA = makeRow('Always validate request bodies with a Zod schema before persisting.');
    const secretRow = makeRow(`Deploy with the key ${SECRET_LITERAL} in the env file.`);
    const piiRow = makeRow(`Onboarding note: the contractor SSN is ${SSN_LITERAL} for payroll.`);
    const cleanB = makeRow('Prefer Result<T, E> over throwing for all fallible operations here.');

    const result = mergeGovern([cleanA, secretRow], [piiRow, cleanB], deps, {
      policy,
      tenantId: TENANT,
    });

    // The two clean rows survive; the secret + PII rows are turned away.
    expect(result.promoted).toHaveLength(2);
    expect(result.quarantined).toHaveLength(2);

    const promotedHashes = new Set(result.promoted.map((m) => m.contentHash));
    expect(promotedHashes.has(secretRow.contentHash)).toBe(false);
    expect(promotedHashes.has(piiRow.contentHash)).toBe(false);

    // The PII row is caught by the disclosure choke point (runs before policy);
    // the secret row is caught by the disclosure choke point too (secrets are in
    // the disclosure scanner's SECRET_PATTERNS). Both land in 'disclosure'.
    const quarantinedIds = new Set(result.quarantined.map((q) => q.memoryId));
    expect(quarantinedIds.has(secretRow.id)).toBe(true);
    expect(quarantinedIds.has(piiRow.id)).toBe(true);
    for (const q of result.quarantined) {
      expect(q.category).toBe('disclosure');
    }

    // Durable state agrees: only the two clean rows are in curated_memories.
    expect(deps.memoryRepo.count()).toBe(2);
    expect(deps.memoryRepo.findByContentHash(secretRow.contentHash)).toBeNull();
    expect(deps.memoryRepo.findByContentHash(piiRow.contentHash)).toBeNull();
  });

  it('dedupes a row duplicated across both clones by content-derived id (one survives)', () => {
    const policy = makeMergePolicy();
    const content = 'Use a single shared logger configured at process start, never per-module.';

    // The SAME logical memory exists in both clones: identical content AND
    // identical id (content-derived ids are stable across clones).
    const sharedId = '11111111-1111-4111-8111-111111111111';
    const sharedCandidateId = '22222222-2222-4222-8222-222222222222';
    const inA = makeRow(content, { id: sharedId, candidateId: sharedCandidateId });
    const inB = makeRow(content, { id: sharedId, candidateId: sharedCandidateId });

    const uniqueToB = makeRow('A distinct convention that only clone B promoted locally today.');

    const result = mergeGovern([inA], [inB, uniqueToB], deps, { policy, tenantId: TENANT });

    // Union after id-dedup = 2 logical memories (the shared one + B's unique one).
    expect(result.unionSize).toBe(2);
    expect(result.promoted).toHaveLength(2);

    // Exactly one survivor carries the shared content hash - the twin was dropped
    // by id-dedup, not promoted twice.
    const sharedSurvivors = result.promoted.filter((m) => m.content === content);
    expect(sharedSurvivors).toHaveLength(1);
    expect(deps.memoryRepo.findByContentHash(inA.contentHash)).not.toBeNull();
    expect(deps.memoryRepo.count()).toBe(2);
  });

  it('is commutative: A∪B and B∪A produce byte-identical governed state + identical audit outcome', () => {
    const policy = makeMergePolicy();

    // A mixed bag exercising every branch: clean rows, a cross-clone duplicate,
    // a secret row, a PII row - split unevenly across the two clones.
    const dupId = '33333333-3333-4333-8333-333333333333';
    const dupCandId = '44444444-4444-4444-8444-444444444444';
    const dupContent = 'Shared decision: all timestamps are stored as UTC ISO-8601 strings.';

    const a1 = makeRow('Clone A clean row one about dependency injection wiring conventions.');
    const a2 = makeRow(dupContent, { id: dupId, candidateId: dupCandId });
    const aSecret = makeRow(`A note from clone A leaking ${SECRET_LITERAL} into the brain.`);

    const b1 = makeRow('Clone B clean row about retry-with-backoff for idempotent calls only.');
    const b2 = makeRow(dupContent, { id: dupId, candidateId: dupCandId });
    const bPii = makeRow(`Clone B accidentally captured an SSN ${SSN_LITERAL} during intake.`);

    const cloneA = [a1, a2, aSecret];
    const cloneB = [b1, b2, bPii];

    // Two independent DBs so the durable state of each ordering is isolated.
    const dbAB = createTestDatabase();
    const depsAB = makeDeps(dbAB);
    const dbBA = createTestDatabase();
    const depsBA = makeDeps(dbBA);

    const resAB = mergeGovern(cloneA, cloneB, depsAB, { policy, tenantId: TENANT });
    const resBA = mergeGovern(cloneB, cloneA, depsBA, { policy, tenantId: TENANT });

    // Same survivor set + same quarantine set (order-independent comparison via
    // the deterministic sort means even the arrays are identical).
    expect(resAB.unionSize).toBe(resBA.unionSize);
    expect(resAB.promoted.map((m) => m.id)).toEqual(resBA.promoted.map((m) => m.id));
    expect(resAB.quarantined).toEqual(resBA.quarantined);

    // BYTE-IDENTICAL governed state: serialise both DBs' curated_memories ordered
    // by id and compare the JSON verbatim. promotedAt/updatedAt are anchored to a
    // fixed merge epoch, so even the timestamp columns match.
    const dumpMemories = (mr: MemoryRepository): string => {
      const rows = mr.findByLifecycle('active').sort((x, y) => (x.id < y.id ? -1 : 1));
      return JSON.stringify(rows);
    };
    expect(dumpMemories(depsAB.memoryRepo)).toBe(dumpMemories(depsBA.memoryRepo));

    // IDENTICAL audit outcome: the v2 entry_hash chain is timestamp-independent,
    // so the ordered list of (action, memoryId, entry_hash) is identical, and
    // both chains verify clean.
    const dumpAudit = (db2: Database.Database): string => {
      const repo = new AuditRepository(db2);
      const rows = repo
        .findAllChronological()
        .map((r) => `${r.action}:${r.memory_id}:${r.entry_hash}`)
        .sort();
      return rows.join('\n');
    };
    expect(dumpAudit(dbAB)).toBe(dumpAudit(dbBA));
    expect(verifyAuditChain(new AuditRepository(dbAB)).breaks).toHaveLength(0);
    expect(verifyAuditChain(new AuditRepository(dbBA)).breaks).toHaveLength(0);

    dbAB.close();
    dbBA.close();
  });

  it('every surviving row provably passed the full gate (re-running the gate readmits all survivors)', () => {
    const policy = makeMergePolicy();

    const cleanA = makeRow('Use feature flags gated by env, never branch on hostname strings.');
    const secretRow = makeRow(`Hardcoded ${SECRET_LITERAL} should never reach the brain.`);
    const cleanB = makeRow('Wrap all DB writes in a single transaction per request handler.');
    const piiRow = makeRow(`Captured SSN ${SSN_LITERAL} from a pasted form during a session.`);

    const result = mergeGovern([cleanA, secretRow], [cleanB, piiRow], deps, {
      policy,
      tenantId: TENANT,
    });

    expect(result.promoted.length).toBeGreaterThan(0);

    // PROOF the gate actually held: independently re-run BOTH halves of the gate
    // over each survivor and assert it passes - disclosure choke point clean AND
    // the full policy pipeline approves. No survivor could have skipped the gate.
    const pipeline = new PolicyPipeline(policy);
    for (const survivor of result.promoted) {
      // Re-project to the same untrusted candidate the gate built.
      const candidate = MemoryCandidateSchema.parse({
        id: survivor.candidateId,
        status: 'inbox',
        source: survivor.source,
        content: survivor.content,
        title: survivor.title,
        category: survivor.category,
        trustLevel: 'untrusted',
        author: survivor.author,
        tenantId: survivor.tenantId,
        metadata: survivor.metadata,
        prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
        capturedAt: survivor.promotedAt,
      });

      // (a) disclosure choke point: must NOT throw.
      expect(() => assertDisclosureClean(candidate)).not.toThrow(DisclosureRejectedError);

      // (b) policy pipeline: must approve against a fresh (empty) dedupe set -
      //     i.e. nothing about the survivor itself fails secret/length/trust.
      const verdict = pipeline.evaluate(candidate, {
        existingHashes: new Set<string>(),
        tenantId: TENANT,
      });
      expect(verdict.outcome).toBe('approved');
    }

    // And the rejected rows are accounted for in quarantine, never in survivors.
    const promotedHashes = new Set(result.promoted.map((m) => m.contentHash));
    expect(promotedHashes.has(secretRow.contentHash)).toBe(false);
    expect(promotedHashes.has(piiRow.contentHash)).toBe(false);
  });
});
