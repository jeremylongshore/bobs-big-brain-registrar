import { deriveMemoryId } from '@qmd-team-intent-kb/common';
import { makeMemory } from './fixtures.js';
import { mergeGovern } from '../merge/merge-gate.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { createTestDatabase } from '@qmd-team-intent-kb/store';
import { Curator } from '../curator.js';
import { promote } from '../promotion/promoter.js';
import {
  requireLegacySourceAdmission,
  SourceEnrollmentRequiredError,
} from '../origin/source-enrollment.js';
import { sourceGovernanceRepositories } from '../origin/source-governance-prepare.js';
import { applySourceGovernance, previewSourceGovernance } from '../origin/source-governance.js';
import { signSourceClassification } from '../origin/source-classification-codec.js';
import { makeSourceGovernanceFixture } from './source-governance-fixtures.js';

let db: ReturnType<typeof createTestDatabase>;
let deps: ReturnType<typeof sourceGovernanceRepositories>;
let f: ReturnType<typeof makeSourceGovernanceFixture>;
beforeEach(() => {
  db = createTestDatabase();
  deps = sourceGovernanceRepositories(db);
  f = makeSourceGovernanceFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});
function store(registry: unknown = f.registry) {
  db.prepare('INSERT INTO source_classification_authority VALUES (1, ?)').run(
    JSON.stringify(registry),
  );
}
function direct(dryRun = false, callback?: () => []) {
  return promote(
    {
      candidate: f.candidate,
      contentHash: computeContentHash(f.candidate.content),
      pipelineResult: { candidateId: f.candidate.id, outcome: 'approved', evaluations: [] },
    },
    deps.memoryRepo,
    deps.auditRepo,
    dryRun,
    undefined,
    callback,
  );
}
function untouched() {
  expect(deps.memoryRepo.count()).toBe(0);
  expect(deps.auditRepo.findAllChronological()).toHaveLength(0);
}

describe('persisted source enrollment blocks legacy admission', () => {
  it('refuses the ordinary merge admission path for an enrolled tenant', () => {
    store();
    const contentHash = computeContentHash(f.candidate.content);
    const incoming = makeMemory({
      id: deriveMemoryId(f.candidate.id, contentHash),
      candidateId: f.candidate.id,
      tenantId: f.candidate.tenantId,
      content: f.candidate.content,
      contentHash,
    });
    expect(() => mergeGovern([incoming], [], deps, { tenantId: f.candidate.tenantId })).toThrow(
      SourceEnrollmentRequiredError,
    );
    untouched();
  });
  it('keeps an empty store unenrolled and promotes normally', () => {
    expect(direct().tenantId).toBe(f.candidate.tenantId);
    expect(deps.memoryRepo.count()).toBe(1);
  });
  it('permits explicitly optional enrollment outside the new guarantee', () => {
    f.registry.enrollments[0]!.required = false;
    store();
    expect(direct().tenantId).toBe(f.candidate.tenantId);
  });
  it('isolates another tenant requirement', () => {
    f.registry.enrollments[0]!.tenantId = 'another-tenant';
    store();
    expect(direct().tenantId).toBe(f.candidate.tenantId);
  });
  it.each([false, true])('refuses direct promotion, including dryRun=%s', (dryRun) => {
    store();
    expect(() => direct(dryRun)).toThrow(SourceEnrollmentRequiredError);
    untouched();
  });
  it('does not let an optional second route or different receiver waive a requirement', () => {
    f.registry.enrollments.push({
      ...f.registry.enrollments[0]!,
      receiverId: 'other',
      ingressId: 'manual',
      required: false,
    });
    store();
    expect(() => direct()).toThrow(SourceEnrollmentRequiredError);
    untouched();
  });
  it('refuses curator processing before dedup or no-policy admission', () => {
    direct();
    const before = deps.auditRepo.findAllChronological();
    store();
    const curator = new Curator(deps, { tenantId: f.candidate.tenantId });
    expect(() => curator.processSingle(f.candidate)).toThrow(SourceEnrollmentRequiredError);
    expect(deps.memoryRepo.count()).toBe(1);
    expect(deps.auditRepo.findAllChronological()).toEqual(before);
  });
  it('cannot select a legacy tenant through a mismatched curator configuration', () => {
    store();
    const curator = new Curator(deps, { tenantId: 'another-tenant' });
    expect(() => curator.processSingle(f.candidate)).toThrow(SourceEnrollmentRequiredError);
    f.candidate.tenantId = 'another-tenant';
    const enrolled = new Curator(deps, { tenantId: 'synthetic' });
    expect(() => enrolled.processSingle(f.candidate)).toThrow(SourceEnrollmentRequiredError);
    untouched();
  });
  it.each([
    {},
    null,
    { ...makeSourceGovernanceFixture().registry, version: 2 },
    { ...makeSourceGovernanceFixture().registry, unrecognized: true },
  ])('refuses invalid stored authority without leaking it', (registry) => {
    store(registry);
    expect(() => direct()).toThrow('Invalid stored source authority');
    untouched();
  });
  it('refuses malformed JSON even for an otherwise unenrolled tenant', () => {
    db.prepare('INSERT INTO source_classification_authority VALUES (1, ?)').run('{private-fixture');
    expect(() => direct()).toThrow('Invalid stored source authority');
    untouched();
  });
  it('does not treat a missing authority table as legacy', () => {
    db.exec('DROP TABLE source_classification_authority');
    expect(() => direct()).toThrow();
    untouched();
  });
  it('rejects duplicate registry scopes', () => {
    f.registry.enrollments.push({ ...f.registry.enrollments[0]! });
    store();
    expect(() => direct()).toThrow('Invalid stored source authority');
    untouched();
  });
  it('rechecks after acquiring the promotion transaction', () => {
    const original = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((fn) => {
      store();
      return original(fn);
    });
    expect(() => direct()).toThrow(SourceEnrollmentRequiredError);
    untouched();
  });
  it('rolls back promotion if a callback enrolls the tenant before commit', () => {
    expect(() =>
      direct(false, () => {
        store();
        return [];
      }),
    ).toThrow(SourceEnrollmentRequiredError);
    untouched();
    // The callback mutation shared the promotion transaction and rolls back too.
    expect(() => requireLegacySourceAdmission(db, f.candidate.tenantId)).not.toThrow();
  });
  it('rolls back when a callback corrupts authority before commit', () => {
    expect(() =>
      direct(false, () => {
        store({ version: 99 });
        return [];
      }),
    ).toThrow('Invalid stored source authority');
    untouched();
  });
  it('admits the source-governance core using stored authority', () => {
    deps.candidateRepo.insert(f.candidate, computeContentHash(f.candidate.content));
    store();
    const wire = signSourceClassification(f.payload, f.keys.privateKey);
    const context = { readReceiver: () => f.receiver };
    const plan = previewSourceGovernance(f.candidate.id, wire, db, context);
    expect(applySourceGovernance(plan, wire, db, context).settlement.outcome).toBe('promoted');
    expect(deps.candidateRepo.findById(f.candidate.id)?.status).toBe('promoted');
    expect(() => direct()).toThrow(SourceEnrollmentRequiredError);
  });
});
