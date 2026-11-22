import { isDeepStrictEqual } from 'node:util';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { classifyContent, effectiveSensitivity } from '@qmd-team-intent-kb/policy-engine';
import { AuditEvent, MemoryCandidate, type Sensitivity } from '@qmd-team-intent-kb/schema';
import {
  MemoryRepository,
  CandidateRepository,
  type AuditRepository,
} from '@qmd-team-intent-kb/store';
import { verifySourceClassification } from './source-classification.js';
import { classificationCanonicalJson, classificationHash } from './source-classification-codec.js';
import {
  SignedSourceClassification,
  SourceClassificationReceiver,
} from './source-classification-schema.js';
import {
  ProvenanceFloor,
  PROVENANCE_FLOOR_KIND,
  PROVENANCE_FLOOR_ACTOR,
  provenanceFloorEventId,
  provenanceMinimumSensitivity,
} from '../recovery/provenance-sensitivity-constraint.js';
import { resolveCandidateMinimumSensitivity } from '../recovery/sensitivity-constraint.js';

/** Include pre-existing rows and legacy candidate-scoped recovery floors before deduplication. */
export function combinedProvenanceFloor(
  candidate: MemoryCandidate,
  sourceFloor: Sensitivity,
  audit: AuditRepository,
): Sensitivity {
  let floor = effectiveSensitivity(
    sourceFloor,
    classifyContent(candidate.content).sensitivityLevel,
  );
  const ids = new Set([candidate.id]);
  const hash = computeContentHash(candidate.content);
  for (const row of new MemoryRepository(audit.connection).findByTenant(candidate.tenantId)) {
    if (row.contentHash !== hash) continue;
    if (computeContentHash(row.content) !== hash) throw new Error('Invalid content alias');
    ids.add(row.candidateId);
    floor = effectiveSensitivity(floor, row.sensitivity);
  }
  for (const row of new CandidateRepository(audit.connection).findByTenant(candidate.tenantId)) {
    if (computeContentHash(row.content) === hash) ids.add(row.id);
  }
  for (const id of ids)
    floor = effectiveSensitivity(
      floor,
      resolveCandidateMinimumSensitivity({ ...candidate, id }, audit),
    );
  return floor;
}

/** Internal write primitive, not an admission API. The enclosing governance
 * transaction must also tighten existing content aliases, enforce policy, recheck
 * current authority and retain the final outcome. Never call this to settle a
 * standalone live capture. No unchecked caller floor or cached verdict is accepted.
 */
export function recordProvenanceFloorInTransaction(
  candidateInput: MemoryCandidate,
  serialized: string,
  registry: unknown,
  receiverInput: unknown,
  audit: AuditRepository,
): AuditEvent {
  if (!audit.connection.inTransaction)
    throw new Error('Provenance floor requires an enclosing transaction');
  const candidate = MemoryCandidate.parse(candidateInput);
  const receiver = SourceClassificationReceiver.parse(receiverInput);
  const verified = verifySourceClassification({ candidate, serialized, registry, receiver });
  if (verified.status !== 'verified')
    throw new Error('Provenance floor requires current verified source authority');
  const { payload } = SignedSourceClassification.parse(JSON.parse(serialized));
  const details = ProvenanceFloor.parse({
    kind: PROVENANCE_FLOOR_KIND,
    candidateId: candidate.id,
    contentHash: computeContentHash(candidate.content),
    minimumSensitivity: combinedProvenanceFloor(candidate, verified.minimumSensitivity, audit),
    candidateSnapshotDigest: classificationHash(classificationCanonicalJson(candidate)),
    assertionDigest: verified.assertionDigest,
    profileDigest: verified.profileDigest,
    registryDigest: verified.registryDigest,
    enrollmentRevision: verified.enrollmentRevision,
    replayIdentity: verified.replayIdentity,
    producerDigest: classificationHash(payload.producerId),
    keyDigest: classificationHash(classificationCanonicalJson([payload.producerId, payload.keyId])),
  });
  const id = provenanceFloorEventId(details.replayIdentity);
  const existing = audit
    .findByTenantAndAction(candidate.tenantId, 'governed')
    .find((event) => event.id === id);
  if (existing) {
    provenanceMinimumSensitivity(existing, candidate);
    const previous = ProvenanceFloor.parse(existing.details);
    // Registry/enrollment may change without altering an authorized assertion.
    // Return historical evidence, never overwrite its original authority snapshot.
    for (const key of [
      'assertionDigest',
      'candidateSnapshotDigest',
      'profileDigest',
      'producerDigest',
      'keyDigest',
    ] as const) {
      if (previous[key] !== details[key]) throw new Error('Provenance assertion replay mismatch');
    }
    return existing;
  }
  const event = AuditEvent.parse({
    id,
    action: 'governed',
    memoryId: candidate.id,
    tenantId: candidate.tenantId,
    actor: PROVENANCE_FLOOR_ACTOR,
    timestamp: receiver.now,
    reason: 'Retain authenticated source-profile minimum sensitivity',
    details,
  });
  provenanceMinimumSensitivity(event, candidate);
  audit.insert(event);
  const retained = audit
    .findByMemoryAndTenant(candidate.id, candidate.tenantId)
    .find((entry) => entry.id === id);
  if (!isDeepStrictEqual(retained, event))
    throw new Error('Provenance sensitivity receipt was not retained');
  return event;
}
