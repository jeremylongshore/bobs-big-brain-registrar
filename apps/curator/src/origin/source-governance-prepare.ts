import type Database from 'better-sqlite3';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { PolicyPipeline } from '@qmd-team-intent-kb/policy-engine';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  MemoryLinksRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { classificationCanonicalJson, classificationHash } from './source-classification-codec.js';
import { verifySourceClassification } from './source-classification.js';
import { SourceClassificationReceiver } from './source-classification-schema.js';
import { combinedProvenanceFloor } from './source-floor-writer.js';
import { SourceGovernancePlan, type SourceGovernanceContext } from './source-governance-schema.js';

export function sourceGovernanceDigest(value: unknown): string {
  return classificationHash(classificationCanonicalJson(value));
}
export function sourceGovernanceRepositories(db: Database.Database) {
  return {
    candidateRepo: new CandidateRepository(db),
    memoryRepo: new MemoryRepository(db),
    auditRepo: new AuditRepository(db),
    policyRepo: new PolicyRepository(db),
    linksRepo: new MemoryLinksRepository(db),
  };
}
export function requireSourceGovernanceChain(audit: AuditRepository): void {
  const chain = verifyAuditChain(audit);
  if (
    chain.breaks.length ||
    chain.unverifiedRows ||
    audit.findAllChronological().some((r) => r.hash_version !== 1 && r.hash_version !== 2)
  )
    throw new Error('Source governance requires a valid audit chain');
}
export function prepareSourceGovernance(
  candidateId: string,
  serialized: string,
  db: Database.Database,
  context: SourceGovernanceContext,
) {
  const deps = sourceGovernanceRepositories(db);
  requireSourceGovernanceChain(deps.auditRepo);
  const candidate = MemoryCandidate.parse(deps.candidateRepo.findById(candidateId));
  const authority = context.readAuthority();
  const receiver = SourceClassificationReceiver.parse(authority.receiver);
  const verified = verifySourceClassification({ ...authority, receiver, candidate, serialized });
  if (verified.status !== 'verified')
    throw new Error('Source governance requires current verified authority');
  // Re-read after the authority provider; it is trusted but must not move the
  // selected row between capture of its snapshot and the prepared transaction.
  if (
    sourceGovernanceDigest(deps.candidateRepo.findById(candidateId)) !==
    sourceGovernanceDigest(candidate)
  )
    throw new Error('Candidate changed while loading source authority');
  const policies = deps.policyRepo.findByTenant(candidate.tenantId);
  const rows = deps.memoryRepo.findByTenant(candidate.tenantId);
  const candidates = deps.candidateRepo.findByTenant(candidate.tenantId);
  const floor = combinedProvenanceFloor(candidate, verified.minimumSensitivity, deps.auditRepo);
  if (policies.filter((p) => p.enabled).length > 1)
    throw new Error('Ambiguous source governance policy');
  const policy = policies.find((p) => p.enabled);
  const policyResult = policy
    ? new PolicyPipeline(policy).evaluate(candidate, {
        minimumSensitivity: floor,
        tenantId: candidate.tenantId,
        existingHashes: new Set(rows.map((r) => r.contentHash)),
        getActiveMemoriesInCategory: (category) =>
          rows
            .filter((r) => r.lifecycle === 'active' && r.category === category)
            .map((r) => ({ id: r.id, content: r.content })),
      })
    : { outcome: 'approved' as const };
  const plan = SourceGovernancePlan.parse({
    version: 1,
    candidateId,
    tenantId: candidate.tenantId,
    receiverId: receiver.receiverId,
    ingressId: receiver.ingressId,
    envelopeDigest: classificationHash(serialized),
    candidateSnapshotDigest: sourceGovernanceDigest(candidate),
    assertionDigest: verified.assertionDigest,
    replayIdentity: verified.replayIdentity,
    authorityDigest: sourceGovernanceDigest(verified),
    policyDigest: sourceGovernanceDigest(policies),
    configDigest: sourceGovernanceDigest({
      originSecretDigest:
        context.originSecret === undefined ? null : classificationHash(context.originSecret),
    }),
    stateDigest: sourceGovernanceDigest({ rows, candidates, tip: deps.auditRepo.findChainTip() }),
    minimumSensitivity: floor,
    restrictionOnly: candidate.status !== 'inbox',
    policyOutcome: policyResult.outcome,
  });
  return {
    deps,
    candidate,
    authority,
    receiver,
    plan,
    aliases: rows.filter((r) => r.contentHash === computeContentHash(candidate.content)),
  };
}
