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

import { randomUUID } from 'node:crypto';
import { recordCandidateMinimumSensitivity } from '../recovery/sensitivity-constraint.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  MemoryRepository,
  AuditRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import {
  assertDisclosureClean,
  computeContentHash,
  deriveMemoryId,
  DisclosureRejectedError,
} from '@qmd-team-intent-kb/common';
import { PolicyPipeline } from '@qmd-team-intent-kb/policy-engine';
import { GovernancePolicy } from '@qmd-team-intent-kb/schema';
import type {
  CuratedMemory,
  GovernancePolicy as GovernancePolicyType,
} from '@qmd-team-intent-kb/schema';
import {
  mergeGovern,
  mergeGovernFold,
  MergeIdInvariantError,
  EmptyMergeFoldError,
} from '../merge/merge-gate.js';
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
 * Build a promoted CuratedMemory the way the canonical promotion path
 * ({@link promote}) would - in particular with a CONTENT-DERIVED id
 * `deriveMemoryId(candidateId, contentHash)`. This matters because the merge gate
 * now enforces an entry invariant: every row crossing a clone boundary must carry
 * a content-derived id (a stray random v4 is rejected as
 * {@link MergeIdInvariantError}). A legitimately-promoted clone export always
 * satisfies that invariant, so the fixture used by the happy-path tests must too.
 *
 * The id is derived from the row's `candidateId` (overridable) and the SHA-256
 * hash of its `content`, exactly as {@link promote} derives it. So:
 *
 *   - two rows with the SAME content AND the SAME `candidateId` get the SAME id
 *     (a cross-clone duplicate - the id-dedup case);
 *   - two rows with the same content but DIFFERENT `candidateId`s get DIFFERENT
 *     ids but the SAME `contentHash` (the policy dedup_check case).
 *
 * Pass `id` explicitly to deliberately plant a NON-derived id (the negative
 * invariant test); any explicit `id` override wins over the derivation.
 */
function makeRow(content: string, overrides?: Partial<CuratedMemory>): CuratedMemory {
  const candidateId = overrides?.candidateId ?? randomUUID();
  const contentHash = overrides?.contentHash ?? computeContentHash(content);
  const id = overrides?.id ?? deriveMemoryId(candidateId, contentHash);
  return makeCuratedMemory({ content, candidateId, contentHash, id, ...overrides });
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
    // identical candidateId, so makeRow derives the SAME content-derived id for
    // both (content-derived ids are stable across clones - this is exactly what
    // lets id-dedup collapse them).
    const sharedCandidateId = '22222222-2222-4222-8222-222222222222';
    const inA = makeRow(content, { candidateId: sharedCandidateId });
    const inB = makeRow(content, { candidateId: sharedCandidateId });

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

  it('policy dedup_check catches same-content rows that arrive under different candidate ids (dedup_check is not shadowed by id-dedup)', () => {
    const policy = makeMergePolicy();

    // Two SEPARATE capture events whose content converged on the same string.
    // Distinct candidateIds -> distinct CONTENT-DERIVED ids (deriveMemoryId folds
    // candidateId), but identical contentHash. The upstream id-dedup (the unionById
    // map, which keys purely on .id) CANNOT collapse these - both rows survive into
    // the policy pipeline. The only thing that can catch the second one is the
    // CONTENT-HASH dedup_check rule comparing against the accreting existingHashes
    // set. This is the path under test. (Ids are NOT pinned here: pinning a literal
    // would violate the gate's content-derived-id entry invariant; instead each
    // row's id is derived from its own candidateId + contentHash, exactly as a real
    // promoted clone export would carry it.)
    const convergedContent =
      'Decision: every public API response is wrapped in a discriminated-union Result envelope.';

    const rowA = makeRow(convergedContent, {
      candidateId: '66666666-6666-4666-8666-666666666666',
    });
    const rowB = makeRow(convergedContent, {
      candidateId: '88888888-8888-4888-8888-888888888888',
    });

    // Sanity: same content + same hash, but genuinely different identity. If these
    // shared an id the id-dedup would shadow the path we mean to exercise.
    expect(rowA.id).not.toBe(rowB.id);
    expect(rowA.candidateId).not.toBe(rowB.candidateId);
    expect(rowA.contentHash).toBe(rowB.contentHash);

    // Pre-seed the merged DB with an UNRELATED promoted row, so the gate's
    // existingHashes seed (memoryRepo.getAllContentHashes()) is non-empty and the
    // dedup_check rule is not vacuous on the seed path. Its hash differs from the
    // converged content, so neither rowA nor rowB matches it on the seed - the
    // catch comes from intra-pass ACCRETION of rowA's hash, proving the gate
    // accretes existingHashes between rows.
    const seed = makeRow('An unrelated convention seeded into the merged DB before the pass runs.');
    deps.memoryRepo.insert(seed);

    const result = mergeGovern([rowA], [rowB], deps, { policy, tenantId: TENANT });

    // Union after id-dedup = 2 logical rows (different ids), both reach the pipeline.
    expect(result.unionSize).toBe(2);

    // Exactly one converged-content survivor; its twin is quarantined by the policy
    // pipeline's dedup_check, NOT by the id-dedup (which never fired - distinct ids).
    expect(result.promoted).toHaveLength(1);
    expect(result.quarantined).toHaveLength(1);

    const refused = result.quarantined[0]!;
    expect(refused.category).toBe('policy');
    // The reason is the rejecting RULE id from the pipeline verdict. Only the
    // pipeline-verdict branch (merge-gate.ts:276-288) produces a rule id here; the
    // no-policy fallback would report 'duplicate-content'. Asserting the rule id
    // makes this test fail if the pipeline branch is disabled - i.e. NON-VACUOUS.
    expect(refused.reason).toBe('rule-dedup');

    // The refused row is reported under one of the two converged-content rows'
    // SOURCE ids - the quarantine record carries the union row's input .id
    // (merge-gate.ts:282), unchanged. (The survivor, by contrast, is re-promoted
    // through the canonical path, so ITS .id is re-derived from candidateId +
    // contentHash, not the input id - which is why we match the survivor on content,
    // not id.)
    const convergedInputIds = new Set([rowA.id, rowB.id]);
    expect(convergedInputIds.has(refused.memoryId)).toBe(true);

    const convergedSurvivors = result.promoted.filter((m) => m.content === convergedContent);
    expect(convergedSurvivors).toHaveLength(1);

    // count() = seed + the single converged survivor = 2.
    expect(deps.memoryRepo.count()).toBe(2);
    expect(deps.memoryRepo.findByContentHash(rowA.contentHash)).not.toBeNull();
  });

  it('rejects a row whose id is not content-derived (a stray v4) at gate entry, before any promotion', () => {
    const policy = makeMergePolicy();

    // A clean, otherwise-promotable row whose id is a RANDOM v4 - NOT
    // deriveMemoryId(candidateId, contentHash). This is exactly what an old or
    // out-of-band code path (e.g. a pre-8da.5 crypto.randomUUID() site) would
    // leave on a clone export. Its content is clean and would sail through the
    // disclosure choke point + the full policy pipeline - so ONLY the gate-entry
    // id invariant can catch it.
    const strayV4 = randomUUID();
    const content = 'A perfectly clean convention whose row id was minted at random, not derived.';
    const poison = makeRow(content, { id: strayV4 });

    // Sanity: the planted id really is the wrong one (not the derived id), so the
    // test is exercising the invariant and not an accidental match.
    expect(poison.id).toBe(strayV4);
    expect(poison.id).not.toBe(deriveMemoryId(poison.candidateId, poison.contentHash));

    // A second, legitimately-promotable row paired in the SAME pass. Even though it
    // is clean and content-derived, the gate must fail the WHOLE pass loudly the
    // moment it meets the poison row - a merge that silently dropped the bad row and
    // kept going would be worse (it hides a real upstream id bug).
    const cleanDerived = makeRow(
      'A clean, content-derived row that shares the pass with the poison.',
    );

    // (a) FAILS LOUD: the gate throws MergeIdInvariantError, naming the offending
    //     id and the id its lineage should have produced - never the content.
    let thrown: unknown;
    try {
      mergeGovern([poison], [cleanDerived], deps, { policy, tenantId: TENANT });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MergeIdInvariantError);
    const invariantErr = thrown as MergeIdInvariantError;
    expect(invariantErr.actualId).toBe(strayV4);
    expect(invariantErr.expectedId).toBe(deriveMemoryId(poison.candidateId, poison.contentHash));
    // Non-leak contract: the error message must not embed the row content.
    expect(invariantErr.message).not.toContain(content);

    // (b) NOTHING was promoted - the throw happens before any write, so the durable
    //     state is untouched even though one of the two rows was perfectly clean.
    expect(deps.memoryRepo.count()).toBe(0);
    expect(deps.auditRepo.findAllChronological()).toHaveLength(0);

    // (c) The same clean, content-derived row promotes fine on its own - proving the
    //     gate rejected the pass for the id invariant specifically, not for anything
    //     about the clean row.
    const ok = mergeGovern([cleanDerived], [], deps, { policy, tenantId: TENANT });
    expect(ok.promoted).toHaveLength(1);
    expect(ok.quarantined).toHaveLength(0);
    expect(deps.memoryRepo.count()).toBe(1);
  });

  describe('merge snapshot and persistence transaction', () => {
    it('rolls back the entire pass if a later promotion fails', () => {
      const first = makeRow('First independent incoming snapshot for a transactional merge.');
      const second = makeRow('Second independent incoming snapshot for a transactional merge.');
      const insert = deps.memoryRepo.insert.bind(deps.memoryRepo);
      let calls = 0;
      const spy = vi.spyOn(deps.memoryRepo, 'insert').mockImplementation((memory) => {
        if (++calls === 2) throw new Error('Synthetic later insert failure');
        return insert(memory);
      });
      try {
        expect(() => mergeGovern([first], [second], deps, { tenantId: TENANT })).toThrow(
          'Synthetic later insert failure',
        );
        expect(calls).toBe(2);
        expect(deps.memoryRepo.count()).toBe(0);
        expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('refuses repositories from different connections before writes', () => {
      const other = createTestDatabase();
      try {
        const auditRepo = new AuditRepository(other);
        expect(() =>
          mergeGovern(
            [makeRow('A cross-connection merge must refuse before persistence.')],
            [],
            { ...deps, auditRepo },
            { tenantId: TENANT },
          ),
        ).toThrow('share one database connection');
        expect(deps.memoryRepo.count()).toBe(0);
        expect(auditRepo.findAllChronological()).toHaveLength(0);
      } finally {
        other.close();
      }
    });

    it('previews on a query-only connection without writes', () => {
      db.pragma('query_only = ON');
      try {
        const result = mergeGovern(
          [makeRow('A preview computes the merge without acquiring write authority.')],
          [],
          deps,
          { tenantId: TENANT, dryRun: true },
        );
        expect(result.promoted).toHaveLength(1);
        expect(deps.memoryRepo.count()).toBe(0);
        expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
      } finally {
        db.pragma('query_only = OFF');
      }
    });
  });

  describe('content-duplicate constraint preflight', () => {
    for (const foreign of [false, true]) {
      it(`refuses a malformed matching stored identity without exposing row details, foreign=${foreign}`, () => {
        const incoming = makeRow('A valid incoming identity with damaged destination metadata.');
        deps.memoryRepo.insert({ ...incoming, tenantId: foreign ? 'other-tenant' : TENANT });
        db.prepare('UPDATE curated_memories SET metadata_json = ? WHERE id = ?').run(
          JSON.stringify({ tags: 'PRIVATE-STORED-MARKER' }),
          incoming.id,
        );
        let failure: unknown;
        try {
          mergeGovern([incoming], [], deps, { tenantId: TENANT });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
          foreign
            ? 'Merge identity is already bound outside the destination tenant'
            : 'Merge destination rows could not be read and schema-validated',
        );
        expect((failure as Error).message).not.toContain('PRIVATE-STORED-MARKER');
        expect(deps.memoryRepo.count()).toBe(1);
        expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
      });
    }

    for (const corrupt of ['hash', 'id'] as const) {
      it(`refuses destination ${corrupt} inconsistencies before writes`, () => {
        const stored = makeRow('An existing destination record requiring integrity checks.');
        deps.memoryRepo.insert(stored);
        if (corrupt === 'hash')
          db.prepare('UPDATE curated_memories SET content = ? WHERE id = ?').run(
            'Changed stored body without updating its digest.',
            stored.id,
          );
        else
          db.prepare('UPDATE curated_memories SET id = ? WHERE id = ?').run(
            randomUUID(),
            stored.id,
          );
        expect(() =>
          mergeGovern([makeRow('An unrelated valid source record.')], [], deps, {
            tenantId: TENANT,
          }),
        ).toThrow('Merge destination contains an inconsistent content or identity binding');
        expect(deps.memoryRepo.count()).toBe(1);
        expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
      });
    }

    it('refuses a foreign candidate binding hidden behind a legacy memory ID', () => {
      const foreign = makeRow('A candidate already stored in another tenant.', {
        tenantId: 'other-tenant',
      });
      deps.memoryRepo.insert(foreign);
      db.prepare('UPDATE curated_memories SET id = ? WHERE id = ?').run(randomUUID(), foreign.id);
      expect(() =>
        mergeGovern([{ ...foreign, tenantId: TENANT }], [], deps, { tenantId: TENANT }),
      ).toThrow('conflicting candidate content binding');
      expect(deps.memoryRepo.count()).toBe(1);
      expect(deps.memoryRepo.findByTenant(TENANT)).toHaveLength(0);
      expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
    });

    it('identifies malformed unrelated destination data without changing either store', () => {
      const stored = makeRow('An unrelated destination record with synthetic damage.');
      deps.memoryRepo.insert(stored);
      db.prepare("UPDATE curated_memories SET content = '' WHERE id = ?").run(stored.id);
      expect(() =>
        mergeGovern([makeRow('A valid independent incoming record.')], [], deps, {
          tenantId: TENANT,
        }),
      ).toThrow('Merge destination rows could not be read and schema-validated');
      expect(deps.memoryRepo.count()).toBe(1);
      expect(
        db.prepare('SELECT content FROM curated_memories WHERE id = ?').get(stored.id),
      ).toEqual({ content: '' });
      expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
    });

    for (const lifecycle of ['active', 'superseded'] as const) {
      for (const withPolicy of [false, true]) {
        it(`refuses changed candidate content in another tenant, lifecycle=${lifecycle}, policy=${withPolicy}`, () => {
          const foreign = makeRow('Original body in a separate tenant.', {
            tenantId: 'other-tenant',
            lifecycle,
            ...(lifecycle === 'superseded'
              ? {
                  supersession: {
                    supersededBy: randomUUID(),
                    reason: 'Synthetic prior replacement',
                    linkedAt: NOW,
                  },
                }
              : {}),
          });
          deps.memoryRepo.insert(foreign);
          const incoming = makeRow('Changed body reusing the foreign candidate identity.', {
            candidateId: foreign.candidateId,
          });
          const before = JSON.stringify(deps.memoryRepo.findByTenant('other-tenant'));
          expect(() =>
            mergeGovern([incoming], [], deps, {
              tenantId: TENANT,
              ...(withPolicy ? { policy: makeMergePolicy() } : {}),
            }),
          ).toThrow('candidate content binding');
          expect(deps.memoryRepo.count()).toBe(1);
          expect(JSON.stringify(deps.memoryRepo.findByTenant('other-tenant'))).toBe(before);
          expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
        });
      }
    }

    it('refuses pre-existing cross-tenant candidate conflicts without rewriting either row', () => {
      const incoming = makeRow('Existing destination body with an ambiguous candidate binding.');
      const foreign = makeRow('Conflicting historical body for that same candidate.', {
        candidateId: incoming.candidateId,
        tenantId: 'other-tenant',
      });
      deps.memoryRepo.insert(incoming);
      deps.memoryRepo.insert(foreign);
      const before = JSON.stringify([
        deps.memoryRepo.findById(incoming.id),
        deps.memoryRepo.findById(foreign.id),
      ]);
      expect(() => mergeGovern([incoming], [], deps, { tenantId: TENANT })).toThrow(
        'candidate content binding',
      );
      expect(
        JSON.stringify([
          deps.memoryRepo.findById(incoming.id),
          deps.memoryRepo.findById(foreign.id),
        ]),
      ).toBe(before);
      expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
    });

    for (const destination of [false, true]) {
      for (const withPolicy of [false, true]) {
        it(`refuses one candidate bound to different bodies, destination=${destination}, policy=${withPolicy}`, () => {
          const first = makeRow('The original content bound to this candidate identity.');
          const changed = makeRow('Changed content retaining the original candidate identity.', {
            candidateId: first.candidateId,
          });
          expect(first.id).not.toBe(changed.id);
          if (destination) deps.memoryRepo.insert(first);
          const before = JSON.stringify(deps.memoryRepo.findByTenant(TENANT));
          const options = {
            tenantId: TENANT,
            ...(withPolicy ? { policy: makeMergePolicy() } : {}),
          };
          if (destination) {
            expect(() => mergeGovern([changed], [], deps, options)).toThrow(
              'candidate content binding',
            );
          } else {
            for (const pair of [
              [first, changed],
              [changed, first],
            ]) {
              expect(() => mergeGovern([pair[0]!], [pair[1]!], deps, options)).toThrow(
                'candidate content binding',
              );
            }
          }
          expect(JSON.stringify(deps.memoryRepo.findByTenant(TENANT))).toBe(before);
          expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
        });
      }
    }

    for (const sameIdentity of [false, true]) {
      for (const withPolicy of [false, true]) {
        it(`refuses destination conflicts, same identity=${sameIdentity}, policy=${withPolicy}`, () => {
          const stored = makeRow('A planning record already present in the destination.');
          deps.memoryRepo.insert(stored);
          const incoming = sameIdentity
            ? { ...stored, sensitivity: 'confidential' as const }
            : makeRow(stored.content, {
                sensitivity: 'confidential',
                metadata: { filePaths: [], tags: [], audience: 'owner' },
              });
          const unrelated = makeRow('An unrelated valid incoming row must not be partly written.');
          const before = JSON.stringify(deps.memoryRepo.findByTenant(TENANT));
          expect(() =>
            mergeGovern([unrelated], [incoming], deps, {
              tenantId: TENANT,
              ...(withPolicy ? { policy: makeMergePolicy() } : {}),
            }),
          ).toThrow(/conflicting.*(?:snapshot|constraint)/);
          expect(JSON.stringify(deps.memoryRepo.findByTenant(TENANT))).toBe(before);
          expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
        });
      }
    }

    it('deduplicates an identical destination snapshot without changing it', () => {
      const stored = makeRow(
        'An identical source and destination snapshot needs no new promotion.',
      );
      deps.memoryRepo.insert(stored);
      const result = mergeGovern([stored], [], deps, { tenantId: TENANT });
      expect(result.promoted).toHaveLength(0);
      expect(result.quarantined).toHaveLength(1);
      expect(deps.memoryRepo.findById(stored.id)).toEqual(stored);
      expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
    });

    it('refuses a cross-tenant identity collision before writing another incoming row', () => {
      const stored = makeRow('A globally keyed identity already belongs to another tenant.', {
        tenantId: 'other-tenant',
      });
      deps.memoryRepo.insert(stored);
      const incoming = { ...stored, tenantId: TENANT };
      const unrelated = makeRow('Another incoming record must remain unwritten on collision.');
      expect(() => mergeGovern([unrelated], [incoming], deps, { tenantId: TENANT })).toThrow(
        'outside the destination tenant',
      );
      expect(deps.memoryRepo.count()).toBe(1);
      expect(deps.memoryRepo.findById(stored.id)).toEqual(stored);
      expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
    });

    it('does not deduplicate against another tenant content', () => {
      const stored = makeRow('Equal text in another tenant must not suppress this tenant import.', {
        tenantId: 'other-tenant',
      });
      deps.memoryRepo.insert(stored);
      const incoming = makeRow(stored.content);
      const result = mergeGovern([incoming], [], deps, { tenantId: TENANT });
      expect(result.promoted).toHaveLength(1);
      expect(deps.memoryRepo.findByTenant(TENANT)).toHaveLength(1);
      expect(deps.memoryRepo.count()).toBe(2);
      expect(deps.memoryRepo.findById(incoming.id)?.content).toBe(incoming.content);
      expect(deps.memoryRepo.findById(stored.id)).toEqual(stored);
    });

    it('refuses when distinct identities have different destination-local reviewed floors', () => {
      const first = makeRow('Identical content with a reviewed local privacy floor.');
      const second = makeRow(first.content);
      const candidate = MemoryCandidateSchema.parse({
        id: first.candidateId,
        status: 'inbox',
        source: first.source,
        content: first.content,
        title: first.title,
        category: first.category,
        trustLevel: 'untrusted',
        author: first.author,
        tenantId: TENANT,
        metadata: first.metadata,
        capturedAt: NOW,
        prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
      });
      recordCandidateMinimumSensitivity(
        candidate,
        'confidential',
        {
          runId: randomUUID(),
          manifestDigest: computeContentHash('fixture manifest'),
          candidateSnapshotDigest: computeContentHash('fixture snapshot'),
          actor: { type: 'human', id: 'fixture-owner' },
          role: 'owner',
          reason: 'Synthetic review',
        },
        deps.auditRepo,
      );
      const before = JSON.stringify(deps.auditRepo.findAllChronological());
      for (const pair of [
        [first, second],
        [second, first],
      ]) {
        expect(() => mergeGovern([pair[0]!], [pair[1]!], deps, { tenantId: TENANT })).toThrow(
          'conflicting content constraints',
        );
        expect(deps.memoryRepo.count()).toBe(0);
        expect(JSON.stringify(deps.auditRepo.findAllChronological())).toBe(before);
      }
    });

    for (const field of ['sensitivity', 'audience', 'policy evidence'] as const) {
      for (const withPolicy of [false, true]) {
        it(`refuses distinct identities with different ${field}, policy=${withPolicy}`, () => {
          const content = 'The same planning text must not erase a stricter source restriction.';
          const first = makeRow(content);
          const second = makeRow(content);
          if (field === 'sensitivity') second.sensitivity = 'confidential';
          if (field === 'audience') second.metadata = { ...second.metadata, audience: 'owner' };
          if (field === 'policy evidence')
            second.policyEvaluations = [
              {
                policyId: randomUUID(),
                ruleId: 'fixture',
                result: 'flag',
                reason: 'review',
                evaluatedAt: NOW,
              },
            ];
          const options = {
            tenantId: TENANT,
            ...(withPolicy ? { policy: makeMergePolicy() } : {}),
          };
          for (const pair of [
            [first, second],
            [second, first],
          ]) {
            expect(() => mergeGovern([pair[0]!], [pair[1]!], deps, options)).toThrow(
              'conflicting content constraints',
            );
            expect(deps.memoryRepo.count()).toBe(0);
            expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
          }
        });
      }
    }
  });

  describe('whole-input preflight before persistence', () => {
    it('keeps serialized merge results and audit records identical when nested object keys are reordered', () => {
      const row = makeRow('Use explicit versioned schemas for shared knowledge records.', {
        metadata: { filePaths: ['fixture.ts'], tags: ['fixture'], audience: 'owner' },
      });
      function reverseKeys(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(reverseKeys);
        if (value !== null && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, item]) => [key, reverseKeys(item)]),
          );
        }
        return value;
      }
      const reordered = reverseKeys(row) as CuratedMemory;
      const otherDb = createTestDatabase();
      try {
        const other = makeDeps(otherDb);
        const forward = mergeGovern([row], [reordered], deps, { tenantId: TENANT });
        const reverse = mergeGovern([reordered], [row], other, { tenantId: TENANT });
        expect(forward.promoted).toHaveLength(1);
        expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
        expect(JSON.stringify(deps.auditRepo.findAllChronological())).toBe(
          JSON.stringify(other.auditRepo.findAllChronological()),
        );
        expect(verifyAuditChain(deps.auditRepo)).toEqual(verifyAuditChain(other.auditRepo));
      } finally {
        otherDb.close();
      }
    });

    it('validates a later malformed row before promoting any earlier clean row', () => {
      const clean = makeRow('A valid convention that must not be partially written.');
      const bad = {
        ...makeRow('A malformed source record must refuse the whole batch.'),
        title: '',
      };
      expect(() =>
        mergeGovern([clean], [bad], deps, { policy: makeMergePolicy(), tenantId: TENANT }),
      ).toThrow('invalid curated row');
      expect(deps.memoryRepo.count()).toBe(0);
      expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
    });

    it('does not disclose rejected content in a content-binding error', () => {
      const row = makeRow('Original content with a valid source identity.');
      const changed = { ...row, content: 'Synthetic private text that must not appear in errors.' };
      let message = '';
      try {
        mergeGovern([changed], [], deps, { tenantId: TENANT });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('declared hash');
      expect(message).not.toContain(changed.content);
      expect(deps.memoryRepo.count()).toBe(0);
    });

    const mutations: [string, (row: CuratedMemory) => CuratedMemory][] = [
      ['candidate identity', (row) => ({ ...row, candidateId: randomUUID() })],
      [
        'content binding',
        (row) => ({ ...row, content: 'Changed content hidden behind the same id.' }),
      ],
      ['tenant', (row) => ({ ...row, tenantId: 'other-tenant' })],
      ['sensitivity', (row) => ({ ...row, sensitivity: 'confidential' })],
      ['audience', (row) => ({ ...row, metadata: { ...row.metadata, audience: 'owner' } })],
      ['lifecycle', (row) => ({ ...row, lifecycle: 'archived' })],
      ['version', (row) => ({ ...row, version: row.version + 1 })],
      ['timestamp', (row) => ({ ...row, updatedAt: '2026-12-01T00:00:00.000Z' })],
      [
        'policy evidence',
        (row) => ({
          ...row,
          policyEvaluations: [
            {
              policyId: randomUUID(),
              ruleId: 'fixture-rule',
              result: 'pass',
              reason: 'fixture',
              evaluatedAt: NOW,
            },
          ],
        }),
      ],
    ];
    for (const [field, mutate] of mutations) {
      for (const reverse of [false, true]) {
        it(`refuses conflicting ${field}, reverse=${reverse}, without writes`, () => {
          const clean = makeRow(
            'A private planning convention without recognizable personal data.',
          );
          const conflict = mutate(clean);
          const first = reverse ? conflict : clean;
          const second = reverse ? clean : conflict;
          expect(() => mergeGovern([first], [second], deps, { tenantId: TENANT })).toThrow();
          expect(deps.memoryRepo.count()).toBe(0);
          expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
        });
      }
    }
  });

  it('is commutative: A∪B and B∪A produce byte-identical governed state + identical audit outcome', () => {
    const policy = makeMergePolicy();

    // A mixed bag exercising every branch: clean rows, a cross-clone duplicate,
    // a secret row, a PII row - split unevenly across the two clones. The
    // cross-clone duplicate shares content AND candidateId, so makeRow derives the
    // SAME content-derived id for both - the id-dedup case, with ids that honor the
    // gate's content-derived-id entry invariant.
    const dupCandId = '44444444-4444-4444-8444-444444444444';
    const dupContent = 'Shared decision: all timestamps are stored as UTC ISO-8601 strings.';

    const a1 = makeRow('Clone A clean row one about dependency injection wiring conventions.');
    const a2 = makeRow(dupContent, { candidateId: dupCandId });
    const aSecret = makeRow(`A note from clone A leaking ${SECRET_LITERAL} into the brain.`);

    const b1 = makeRow('Clone B clean row about retry-with-backoff for idempotent calls only.');
    const b2 = makeRow(dupContent, { candidateId: dupCandId });
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

  it('mergeGovernFold rejects an empty clone list (no well-defined identity merge)', () => {
    expect(() =>
      mergeGovernFold([], deps, { policy: makeMergePolicy(), tenantId: TENANT }),
    ).toThrow(EmptyMergeFoldError);
  });

  it('mergeGovernFold of a single clone equals the lone two-arg pass (fold([X]) === mergeGovern(X, []))', () => {
    const policy = makeMergePolicy();
    const x1 = makeRow('Single-clone fold row about structured logging field naming conventions.');
    const x2 = makeRow('A second single-clone fold row covering graceful shutdown ordering.');

    const dbFold = createTestDatabase();
    const depsFold = makeDeps(dbFold);
    const dbPair = createTestDatabase();
    const depsPair = makeDeps(dbPair);

    const foldRes = mergeGovernFold([[x1, x2]], depsFold, { policy, tenantId: TENANT });
    const pairRes = mergeGovern([x1, x2], [], depsPair, { policy, tenantId: TENANT });

    expect(foldRes.promoted.map((m) => m.id)).toEqual(pairRes.promoted.map((m) => m.id));
    expect(foldRes.quarantined).toEqual(pairRes.quarantined);
    expect(foldRes.unionSize).toBe(pairRes.unionSize);

    const dumpMemories = (mr: MemoryRepository): string =>
      JSON.stringify(mr.findByLifecycle('active').sort((x, y) => (x.id < y.id ? -1 : 1)));
    expect(dumpMemories(depsFold.memoryRepo)).toBe(dumpMemories(depsPair.memoryRepo));

    dbFold.close();
    dbPair.close();
  });

  it('fold-of-3 is commutative + associative: all 6 orderings of mergeGovernFold([A,B,C]) yield byte-identical governed state AND identical audit chain', () => {
    const policy = makeMergePolicy();

    // Three clones with DELIBERATE cross-clone structure so every gate branch is
    // exercised inside the fold, not just the happy path:
    //   - a duplicate that appears in ALL THREE clones (same content + same
    //     candidateId -> same content-derived id -> id-dedup must collapse it to one
    //     survivor regardless of fold order);
    //   - a duplicate that appears in TWO clones under DIFFERENT candidateIds (same
    //     content, distinct ids -> id-dedup cannot fire; the policy dedup_check must
    //     collapse it, and which copy survives must NOT depend on fold order);
    //   - one secret-bearing row and one PII-bearing row (each must be quarantined
    //     by the disclosure choke point in every ordering);
    //   - plus per-clone unique clean rows.
    const triDupCandId = '33333333-3333-4333-8333-333333333333';
    const triDupContent =
      'Shared across all three clones: config is loaded once at boot, never lazily.';

    // Same content, DIFFERENT candidateIds -> distinct content-derived ids, identical
    // contentHash. Lives in clone A and clone C; the policy dedup_check collapses it.
    const convergedContent =
      'Two clones converged on: all money values are integer cents, never floats.';
    const convergedInA = makeRow(convergedContent, {
      candidateId: '55555555-5555-4555-8555-555555555555',
    });
    const convergedInC = makeRow(convergedContent, {
      candidateId: '77777777-7777-4777-8777-777777777777',
    });
    expect(convergedInA.id).not.toBe(convergedInC.id);
    expect(convergedInA.contentHash).toBe(convergedInC.contentHash);

    const cloneA: CuratedMemory[] = [
      makeRow('Clone A unique: prefer composition over inheritance for service wiring.'),
      makeRow(triDupContent, { candidateId: triDupCandId }),
      makeRow(`Clone A leaked ${SECRET_LITERAL} into a captured note during a session.`),
      convergedInA,
    ];
    const cloneB: CuratedMemory[] = [
      makeRow('Clone B unique: all retries use exponential backoff with full jitter.'),
      makeRow(triDupContent, { candidateId: triDupCandId }),
      makeRow(`Clone B captured a contractor SSN ${SSN_LITERAL} from a pasted form.`),
    ];
    const cloneC: CuratedMemory[] = [
      makeRow('Clone C unique: every public handler returns a discriminated Result envelope.'),
      makeRow(triDupContent, { candidateId: triDupCandId }),
      convergedInC,
    ];

    // All 6 orderings/groupings of the three clones. Because mergeGovernFold reduces
    // mergeGovern left-to-right, the permutation order is the fold/grouping order:
    // [A,B,C] folds as ((A∪B)∪C); [C,B,A] as ((C∪B)∪A); etc. Asserting all 6 agree
    // proves both commutativity (any order) AND associativity (any grouping), since
    // the fold's left-reduction realises every parenthesisation reachable by reorder.
    const orderings: (readonly CuratedMemory[])[][] = [
      [cloneA, cloneB, cloneC],
      [cloneA, cloneC, cloneB],
      [cloneB, cloneA, cloneC],
      [cloneB, cloneC, cloneA],
      [cloneC, cloneA, cloneB],
      [cloneC, cloneB, cloneA],
    ];

    const dumpMemories = (mr: MemoryRepository): string => {
      const rows = mr.findByLifecycle('active').sort((x, y) => (x.id < y.id ? -1 : 1));
      return JSON.stringify(rows);
    };
    const dumpAudit = (database: Database.Database): string => {
      const repo = new AuditRepository(database);
      return repo
        .findAllChronological()
        .map((r) => `${r.action}:${r.memory_id}:${r.entry_hash}`)
        .sort()
        .join('\n');
    };

    const memoryDumps: string[] = [];
    const auditDumps: string[] = [];

    for (const ordering of orderings) {
      // Independent fresh DB per ordering so each fold's durable state is isolated.
      const dbN = createTestDatabase();
      const depsN = makeDeps(dbN);

      mergeGovernFold(ordering, depsN, { policy, tenantId: TENANT });

      // DURABLE survivor set is the order-invariant truth (the per-pass result
      // object only reflects the LAST fold step, so its promoted/quarantined counts
      // are NOT fold-order-invariant - the DB is). The merged DB holds exactly the
      // logical survivors: 3 per-clone uniques + 1 tri-clone dup + 1 converged-content
      // survivor = 5. The secret + PII rows never reach it; the converged twin is
      // collapsed by dedup. This count is identical in every ordering.
      expect(depsN.memoryRepo.count()).toBe(5);
      expect(depsN.memoryRepo.findByContentHash(convergedInA.contentHash)).not.toBeNull();
      // Neither the secret nor the PII content is anywhere in the merged DB.
      const allHashes = new Set(depsN.memoryRepo.getAllContentHashes());
      const secretHash = computeContentHash(
        `Clone A leaked ${SECRET_LITERAL} into a captured note during a session.`,
      );
      const piiHash = computeContentHash(
        `Clone B captured a contractor SSN ${SSN_LITERAL} from a pasted form.`,
      );
      expect(allHashes.has(secretHash)).toBe(false);
      expect(allHashes.has(piiHash)).toBe(false);

      // The audit chain produced by this fold ordering verifies clean.
      expect(verifyAuditChain(depsN.auditRepo).breaks).toHaveLength(0);

      memoryDumps.push(dumpMemories(depsN.memoryRepo));
      auditDumps.push(dumpAudit(dbN));

      dbN.close();
    }

    // (a) BYTE-IDENTICAL governed state across all 6 orderings/groupings.
    for (let i = 1; i < memoryDumps.length; i++) {
      expect(memoryDumps[i]).toBe(memoryDumps[0]);
    }
    // (b) IDENTICAL audit outcome (sorted action:memoryId:entry_hash) across all 6.
    for (let i = 1; i < auditDumps.length; i++) {
      expect(auditDumps[i]).toBe(auditDumps[0]);
    }
    // (c) Each chain already asserted clean per-ordering above.
  });
});
