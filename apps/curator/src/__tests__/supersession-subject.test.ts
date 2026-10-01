import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createTestDatabase,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  MemoryLinksRepository,
} from '@qmd-team-intent-kb/store';
import { Curator } from '../curator.js';
import type { CuratorDependencies } from '../curator.js';
import { makeCandidate, makeCuratedMemory, TENANT } from './fixtures.js';

const SUBJECT = 'hosting.gcp';

function deps(): CuratorDependencies {
  const db = createTestDatabase();
  return {
    candidateRepo: new CandidateRepository(db),
    memoryRepo: new MemoryRepository(db),
    policyRepo: new PolicyRepository(db),
    auditRepo: new AuditRepository(db),
    linksRepo: new MemoryLinksRepository(db),
  };
}

let seq = 0;
/** Seed an active, subject-keyed reference memory with a distinct body (so exact-dedup never fires). */
function seedReference(d: CuratorDependencies, subject: string | undefined, title?: string) {
  seq += 1;
  const m = makeCuratedMemory({
    title: title ?? `Reference note number ${seq}`,
    category: 'reference',
    content: `Reference body ${seq} describing how things currently run in production today.`,
    metadata: {
      filePaths: [],
      tags: [],
      ...(subject !== undefined ? { subjects: [subject] } : {}),
    },
  });
  d.memoryRepo.insert(m);
  return m;
}

function decision(subjects: string[], extra: Record<string, unknown> = {}) {
  seq += 1;
  return makeCandidate({
    title: 'Self-host everything on the VPS',
    category: 'decision',
    content: `Decision ${seq}: all hosting moves to the VPS and the old cloud estate is retired for good.`,
    metadata: { filePaths: [], tags: [], subjects },
    ...extra,
  });
}

describe('Curator — subject-keyed supersession', () => {
  let d: CuratorDependencies;
  beforeEach(() => {
    d = deps();
  });

  it('a decision retires a reference with the same subject and ZERO title overlap (cross-category)', () => {
    const ref = seedReference(d, SUBJECT, 'Deploying services to Cloud Run');
    const curator = new Curator(d, { tenantId: TENANT });

    const result = curator.processSingle(decision([SUBJECT]));

    expect(result.outcome).toBe('promoted');
    expect(result.supersedes).toBe(ref.id);
    expect(result.supersededIds).toEqual([ref.id]);
    expect(result.supersessionReport).toBeUndefined();

    const old = d.memoryRepo.findById(ref.id);
    expect(old?.lifecycle).toBe('superseded');
    expect(old?.supersession?.supersededBy).toBe(result.memoryId);
    expect(old?.supersession?.reason).toBe(`Subject match: ${SUBJECT}`);

    // The new decision is active, and the receipt + graph edge name the subject basis.
    expect(d.memoryRepo.findById(result.memoryId as string)?.lifecycle).toBe('active');
    const receipt = d.auditRepo.findByMemory(ref.id).find((e) => e.action === 'superseded');
    expect(receipt?.details).toMatchObject({ basis: 'subject', subject: SUBJECT, similarity: 1 });
    const edges = d.linksRepo?.findBySource(result.memoryId as string) ?? [];
    expect(edges.filter((e) => e.linkType === 'supersedes').map((e) => e.targetMemoryId)).toEqual([
      ref.id,
    ]);
  });

  it('retires several memories on one subject in a single promotion, one receipt each', () => {
    const refs = [seedReference(d, SUBJECT), seedReference(d, SUBJECT), seedReference(d, SUBJECT)];
    const unrelated = seedReference(d, 'hosting.vps');
    const result = new Curator(d, { tenantId: TENANT }).processSingle(decision([SUBJECT]));

    expect([...(result.supersededIds ?? [])].sort()).toEqual(refs.map((r) => r.id).sort());
    for (const r of refs) {
      expect(d.memoryRepo.findById(r.id)?.lifecycle).toBe('superseded');
      expect(d.auditRepo.findByMemory(r.id).filter((e) => e.action === 'superseded')).toHaveLength(
        1,
      );
    }
    expect(d.memoryRepo.findById(unrelated.id)?.lifecycle).toBe('active');
  });

  it('a reference can NOT retire a decision on the same subject', () => {
    const dec = makeCuratedMemory({
      title: 'Use the VPS',
      category: 'decision',
      content: 'Seeded decision body that is unique to this test case alone.',
      metadata: { filePaths: [], tags: [], subjects: [SUBJECT] },
    });
    d.memoryRepo.insert(dec);
    const cand = makeCandidate({
      title: 'Cloud Run notes',
      category: 'reference',
      content: 'A re-captured reference body that is unique to this test case alone.',
      metadata: { filePaths: [], tags: [], subjects: [SUBJECT] },
    });

    const result = new Curator(d, { tenantId: TENANT }).processSingle(cand);

    expect(result.outcome).toBe('promoted');
    expect(result.supersedes).toBeUndefined();
    expect(d.memoryRepo.findById(dec.id)?.lifecycle).toBe('active');
  });

  it('title-only near-duplicate collapse still works for un-keyed memories (legacy path)', () => {
    const old = makeCuratedMemory({
      title: 'Error handling guide',
      category: 'convention',
      content: 'Existing error handling guide for the team at work',
    });
    d.memoryRepo.insert(old);
    const result = new Curator(d, { tenantId: TENANT }).processSingle(
      makeCandidate({
        title: 'Error handling guide',
        category: 'convention',
        content: 'Updated error handling guide with new patterns for the team here today.',
      }),
    );
    expect(result.supersedes).toBe(old.id);
    expect(d.memoryRepo.findById(old.id)?.supersession?.reason).toMatch(
      /^Title similarity: 1\.00$/,
    );
    const receipt = d.auditRepo.findByMemory(old.id).find((e) => e.action === 'superseded');
    expect(receipt?.details).not.toHaveProperty('basis');
  });

  it('does not touch other tenants', () => {
    const other = makeCuratedMemory({
      title: 'Other tenant reference',
      category: 'reference',
      tenantId: 'team-beta',
      content: 'Beta tenant body that must survive untouched by our decision.',
      metadata: { filePaths: [], tags: [], subjects: [SUBJECT] },
    });
    d.memoryRepo.insert(other);
    const result = new Curator(d, { tenantId: TENANT }).processSingle(decision([SUBJECT]));
    expect(result.supersedes).toBeUndefined();
    expect(d.memoryRepo.findById(other.id)?.lifecycle).toBe('active');
  });

  describe('report mode (dry-run)', () => {
    it('detects but retires NOTHING, and reports what it would have retired', () => {
      const ref = seedReference(d, SUBJECT);
      const result = new Curator(d, { tenantId: TENANT, supersessionMode: 'report' }).processSingle(
        decision([SUBJECT]),
      );

      expect(result.outcome).toBe('promoted');
      expect(result.supersedes).toBeUndefined();
      expect(result.supersededIds).toBeUndefined();
      expect(result.supersessionReport?.status).toBe('report');
      expect(result.supersessionReport?.wouldSupersede.map((m) => m.supersededMemoryId)).toEqual([
        ref.id,
      ]);
      expect(d.memoryRepo.findById(ref.id)?.lifecycle).toBe('active');
      expect(d.auditRepo.findByMemory(ref.id).filter((e) => e.action === 'superseded')).toEqual([]);
      expect(d.linksRepo?.findByType('supersedes')).toEqual([]);
    });

    it('omits the report when there is nothing to supersede', () => {
      const result = new Curator(d, { tenantId: TENANT, supersessionMode: 'report' }).processSingle(
        decision([SUBJECT]),
      );
      expect(result.supersessionReport).toBeUndefined();
    });

    it('does not consume the per-run budget', () => {
      for (let i = 0; i < 3; i++) seedReference(d, SUBJECT);
      const curator = new Curator(d, {
        tenantId: TENANT,
        supersessionMode: 'report',
        maxSupersedesPerRun: 1,
      });
      expect(curator.processSingle(decision([SUBJECT])).supersessionReport?.status).toBe('report');
      expect(curator.processSingle(decision([SUBJECT])).supersessionReport?.status).toBe('report');
    });
  });

  describe('mass-supersede guards', () => {
    it('per-promotion cap: a too-broad subject retires NOTHING, still promotes, and says so', () => {
      const refs = Array.from({ length: 4 }, () => seedReference(d, SUBJECT));
      const result = new Curator(d, {
        tenantId: TENANT,
        maxSupersedesPerPromotion: 3,
      }).processSingle(decision([SUBJECT]));

      expect(result.outcome).toBe('promoted');
      expect(result.supersedes).toBeUndefined();
      expect(result.supersessionReport).toEqual({
        status: 'blocked',
        wouldSupersede: [],
        blockedReason: 'subject match exceeds per-promotion cap (3)',
        blockedCount: 4,
      });
      expect(result.reason).toContain('supersession blocked');
      for (const r of refs) expect(d.memoryRepo.findById(r.id)?.lifecycle).toBe('active');
    });

    it('the default per-promotion cap (25) blocks 26 matches', () => {
      for (let i = 0; i < 26; i++) seedReference(d, SUBJECT);
      const result = new Curator(d, { tenantId: TENANT }).processSingle(decision([SUBJECT]));
      expect(result.supersessionReport?.status).toBe('blocked');
      expect(result.supersessionReport?.blockedCount).toBe(26);
      expect(d.memoryRepo.findByTenantAndLifecycle(TENANT, 'superseded')).toEqual([]);
    });

    it('raising maxSupersedesPerPromotion is the explicit opt-in', () => {
      for (let i = 0; i < 4; i++) seedReference(d, SUBJECT);
      const result = new Curator(d, {
        tenantId: TENANT,
        maxSupersedesPerPromotion: 4,
      }).processSingle(decision([SUBJECT]));
      expect(result.supersededIds).toHaveLength(4);
      expect(result.supersessionReport).toBeUndefined();
    });

    it('per-run budget: stops applying subject supersession once spent, but keeps promoting', () => {
      const a = [seedReference(d, 'topic.a'), seedReference(d, 'topic.a')];
      const b = [seedReference(d, 'topic.b'), seedReference(d, 'topic.b')];
      const curator = new Curator(d, { tenantId: TENANT, maxSupersedesPerRun: 3 });

      const first = curator.processSingle(decision(['topic.a']));
      expect(first.supersededIds).toHaveLength(2); // budget 2/3

      const second = curator.processSingle(decision(['topic.b'])); // would make 4 > 3
      expect(second.outcome).toBe('promoted');
      expect(second.supersededIds).toBeUndefined();
      expect(second.supersessionReport).toEqual({
        status: 'blocked',
        wouldSupersede: [],
        blockedReason: 'per-run subject-supersession budget exhausted (3)',
        blockedCount: 2,
      });
      for (const r of a) expect(d.memoryRepo.findById(r.id)?.lifecycle).toBe('superseded');
      for (const r of b) expect(d.memoryRepo.findById(r.id)?.lifecycle).toBe('active');
    });

    it('a promotion that throws (rolled back) does not spend the per-run budget', () => {
      const ref = seedReference(d, 'topic.a');
      const curator = new Curator(d, { tenantId: TENANT, maxSupersedesPerRun: 1 });
      const insert = vi.spyOn(d.memoryRepo, 'insert').mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      expect(() => curator.processSingle(decision(['topic.a']))).toThrow('disk full');
      insert.mockRestore();
      // The failed promotion rolled back: the reference is still active ...
      expect(d.memoryRepo.findById(ref.id)?.lifecycle).toBe('active');
      // ... and the budget of 1 is intact, so the retry still supersedes.
      expect(curator.processSingle(decision(['topic.a'])).supersededIds).toEqual([ref.id]);
    });

    it('per-run budget allows a spend that lands exactly on the limit', () => {
      seedReference(d, 'topic.a');
      seedReference(d, 'topic.a');
      const curator = new Curator(d, { tenantId: TENANT, maxSupersedesPerRun: 2 });
      expect(curator.processSingle(decision(['topic.a'])).supersededIds).toHaveLength(2);
    });

    it('a dry-run Curator persists nothing and does not spend the budget', () => {
      seedReference(d, 'topic.a');
      const curator = new Curator(d, { tenantId: TENANT, dryRun: true, maxSupersedesPerRun: 1 });
      expect(curator.processSingle(decision(['topic.a'])).supersededIds).toHaveLength(1);
      // Same instance, second candidate: still within budget because dry-run spent nothing.
      expect(curator.processSingle(decision(['topic.a'])).supersededIds).toHaveLength(1);
      expect(d.memoryRepo.findByTenantAndLifecycle(TENANT, 'superseded')).toEqual([]);
    });

    it('the legacy title path is not subject to the per-run subject budget', () => {
      const old = makeCuratedMemory({
        title: 'Error handling guide',
        category: 'convention',
        content: 'Existing error handling guide for the team at work',
      });
      d.memoryRepo.insert(old);
      const curator = new Curator(d, { tenantId: TENANT, maxSupersedesPerRun: 0 });
      const result = curator.processSingle(
        makeCandidate({
          title: 'Error handling guide',
          category: 'convention',
          content: 'Updated error handling guide with new patterns for the team here today.',
        }),
      );
      expect(result.supersedes).toBe(old.id);
    });
  });

  it('a stale candidate cannot retire a memory promoted after it was captured', () => {
    const ref = makeCuratedMemory({
      title: 'Newer reference',
      category: 'reference',
      content: 'Newer reference body that postdates the incoming stale decision.',
      promotedAt: '2026-06-01T00:00:00.000Z',
      metadata: { filePaths: [], tags: [], subjects: [SUBJECT] },
    });
    d.memoryRepo.insert(ref);
    const result = new Curator(d, { tenantId: TENANT }).processSingle(
      decision([SUBJECT], { capturedAt: '2026-01-01T00:00:00.000Z' }),
    );
    expect(result.supersedes).toBeUndefined();
    expect(d.memoryRepo.findById(ref.id)?.lifecycle).toBe('active');
  });
});
