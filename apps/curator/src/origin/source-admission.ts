import { readSourceControlInput } from './source-control-read.js';
import type Database from 'better-sqlite3';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { AuditRepository } from '@qmd-team-intent-kb/store';
import { effectiveSensitivity } from '@qmd-team-intent-kb/policy-engine';
import { classificationCanonicalJson, classificationHash } from './source-classification-codec.js';
import { SourceClassificationReceiver } from './source-classification-schema.js';
import { verifySourceClassification } from './source-classification.js';
import { readStoredSourceRegistry, requireLegacySourceAdmission } from './source-enrollment.js';
import {
  ProvenanceFloor,
  provenanceFloorEventId,
  provenanceMinimumSensitivity,
} from '../recovery/provenance-sensitivity-constraint.js';

type Scope = {
  candidateDigest: string;
  serialized: string;
  readReceiver(): unknown;
  receiverScope: string;
  authorityDigest: string;
};
// Internal synchronous capability. No candidate/request flag can construct it.
const scopes = new WeakMap<Database.Database, Scope>();
const digest = (value: unknown) => classificationHash(classificationCanonicalJson(value));

function currentProof(
  db: Database.Database,
  candidate: MemoryCandidate,
  scope: Omit<Scope, 'authorityDigest'>,
) {
  if (!db.inTransaction || digest(MemoryCandidate.parse(candidate)) !== scope.candidateDigest)
    throw new Error('Source admission requires its exact candidate and transaction');
  const receiver = SourceClassificationReceiver.parse(
    readSourceControlInput(db, () => scope.readReceiver()),
  );
  if (digest(MemoryCandidate.parse(candidate)) !== scope.candidateDigest)
    throw new Error('Source admission candidate changed during authority read');
  if (digest({ ...receiver, now: null }) !== scope.receiverScope)
    throw new Error('Source admission receiver changed');
  const verified = verifySourceClassification({
    candidate,
    serialized: scope.serialized,
    receiver,
    registry: readStoredSourceRegistry(db),
  });
  if (verified.status !== 'verified')
    throw new Error('Source admission requires current stored authority');
  const event = new AuditRepository(db)
    .findByTenantAndAction(candidate.tenantId, 'governed')
    .find((entry) => entry.id === provenanceFloorEventId(verified.replayIdentity));
  if (!event) throw new Error('Source admission requires its durable floor');
  provenanceMinimumSensitivity(event, candidate);
  const floor = ProvenanceFloor.parse(event.details);
  if (
    floor.candidateSnapshotDigest !== scope.candidateDigest ||
    floor.assertionDigest !== verified.assertionDigest ||
    floor.registryDigest !== verified.registryDigest ||
    effectiveSensitivity(floor.minimumSensitivity, verified.minimumSensitivity) !==
      floor.minimumSensitivity
  )
    throw new Error('Source admission floor does not match current authority');
  return digest(verified);
}

/** Reverify every shared admission check; a scope never authorizes another candidate. */
export function requireSourceAdmission(db: Database.Database, candidate: MemoryCandidate): void {
  const scope = scopes.get(db);
  if (!scope) return requireLegacySourceAdmission(db, candidate.tenantId);
  if (currentProof(db, candidate, scope) !== scope.authorityDigest)
    throw new Error('Source admission authority changed');
}

/** Internal source-governance integration only. Caller owns the immediate transaction,
 * canonical floor/alias/policy/settlement workflow, and trusted receiver/clock custody.
 * This capability is synchronous and removed even if curation throws.
 */
export function withVerifiedSourceAdmission<T>(
  candidate: MemoryCandidate,
  serialized: string,
  db: Database.Database,
  readReceiver: () => unknown,
  operation: () => T,
): T {
  if (!db.inTransaction || scopes.has(db)) throw new Error('Invalid source admission scope');
  const receiver = SourceClassificationReceiver.parse(readSourceControlInput(db, readReceiver));
  const initial = {
    candidateDigest: digest(MemoryCandidate.parse(candidate)),
    serialized,
    readReceiver,
    receiverScope: digest({ ...receiver, now: null }),
  };
  const scope = { ...initial, authorityDigest: currentProof(db, candidate, initial) };
  scopes.set(db, scope);
  try {
    return operation();
  } finally {
    scopes.delete(db);
  }
}
