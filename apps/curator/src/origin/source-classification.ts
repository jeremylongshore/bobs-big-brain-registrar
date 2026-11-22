import { createPublicKey, verify } from 'node:crypto';
import { MemoryCandidate, type Sensitivity } from '@qmd-team-intent-kb/schema';
import {
  SignedSourceClassification,
  SourceClassificationReceiver,
  SourceClassificationRegistry,
  type SourceClassificationPayload,
} from './source-classification-schema.js';
import {
  classificationCanonicalJson,
  classificationHash,
  MAX_SOURCE_CLASSIFICATION_BYTES,
  MAX_SOURCE_CLASSIFICATION_LIFETIME_MS,
  sourceClassificationSigningBytes,
  sourceProfileDigest,
} from './source-classification-codec.js';

export type SourceClassificationResult =
  | { status: 'legacy' }
  | {
      status: 'refused';
      reason:
        | 'invalid-input'
        | 'missing-assertion'
        | 'untrusted-source'
        | 'binding-mismatch'
        | 'invalid-time'
        | 'invalid-signature';
    }
  | {
      status: 'verified';
      minimumSensitivity: Sensitivity;
      assertionDigest: string;
      profileDigest: string;
      registryDigest: string;
      enrollmentRevision: number;
      replayIdentity: string;
    };

class Refusal extends Error {
  constructor(
    readonly reason: Extract<SourceClassificationResult, { status: 'refused' }>['reason'],
  ) {
    super(reason);
  }
}
function refuse(reason: Refusal['reason']): never {
  throw new Refusal(reason);
}
function parseAssertion(serialized: string) {
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') > MAX_SOURCE_CLASSIFICATION_BYTES
  )
    refuse('invalid-input');
  const envelope = SignedSourceClassification.parse(JSON.parse(serialized));
  // Exact wire form rejects duplicate keys, alternate escapes/order/spacing and unknown fields.
  if (classificationCanonicalJson(envelope) !== serialized) refuse('invalid-input');
  return envelope;
}
function checkCandidate(p: SourceClassificationPayload, candidate: MemoryCandidate): void {
  for (const value of [candidate.content, candidate.title]) {
    if (
      Buffer.byteLength(value, 'utf8') > 1_048_576 ||
      Buffer.from(value, 'utf8').toString('utf8') !== value
    )
      refuse('invalid-input');
  }
  if (
    p.candidateId !== candidate.id ||
    p.tenantId !== candidate.tenantId ||
    p.capturedAt !== candidate.capturedAt ||
    p.context.source !== candidate.source ||
    p.contentHash !== classificationHash(candidate.content) ||
    p.titleHash !== classificationHash(candidate.title)
  )
    refuse('binding-mismatch');
}
function checkTime(
  p: SourceClassificationPayload,
  key: SourceClassificationRegistry['keys'][number],
  now: string,
): void {
  const issued = Date.parse(p.issuedAt),
    expires = Date.parse(p.expiresAt),
    clock = Date.parse(now);
  if (
    issued > clock ||
    expires <= clock ||
    expires <= issued ||
    expires - issued > MAX_SOURCE_CLASSIFICATION_LIFETIME_MS ||
    issued < Date.parse(key.validFrom) ||
    expires > Date.parse(key.validUntil) ||
    Date.parse(p.capturedAt) > issued
  )
    refuse('invalid-time');
}
function resolveAuthority(
  p: SourceClassificationPayload,
  registry: SourceClassificationRegistry,
  receiver: ReturnType<typeof SourceClassificationReceiver.parse>,
) {
  const enrollment = registry.enrollments.find(
    (e) =>
      e.receiverId === receiver.receiverId &&
      e.tenantId === receiver.tenantId &&
      e.ingressId === receiver.ingressId,
  );
  const profile = registry.profiles.find((entry) => entry.id === p.profileId);
  const key = registry.keys.find(
    (entry) => entry.producerId === p.producerId && entry.id === p.keyId,
  );
  if (!enrollment || !profile || !key || key.revoked) refuse('untrusted-source');
  if (
    p.receiverId !== receiver.receiverId ||
    p.tenantId !== receiver.tenantId ||
    key.receiverId !== p.receiverId ||
    key.tenantId !== p.tenantId ||
    profile.receiverId !== p.receiverId ||
    profile.tenantId !== p.tenantId ||
    profile.producerId !== p.producerId ||
    !key.profileIds.includes(profile.id) ||
    !enrollment.profileIds.includes(profile.id)
  )
    refuse('untrusted-source');
  if (
    profile.revision !== p.profileRevision ||
    sourceProfileDigest(profile) !== p.profileDigest ||
    classificationCanonicalJson(profile.context) !== classificationCanonicalJson(p.context)
  )
    refuse('binding-mismatch');
  return { enrollment, profile, key };
}

/** Pure verification against independently loaded receiver authority. No persistence,
 * replay settlement, enrollment loader or promotion authorization is implemented here.
 * A consumer must reverify current authority at commit and settle replay atomically.
 */
export function verifySourceClassification(input: {
  serialized: string | undefined;
  candidate: unknown;
  registry: unknown;
  receiver: unknown;
}): SourceClassificationResult {
  try {
    const registry = SourceClassificationRegistry.parse(input.registry);
    const receiver = SourceClassificationReceiver.parse(input.receiver);
    const candidate = MemoryCandidate.parse(input.candidate);
    if (candidate.tenantId !== receiver.tenantId) refuse('binding-mismatch');
    const enrollment = registry.enrollments.find(
      (e) =>
        e.receiverId === receiver.receiverId &&
        e.tenantId === receiver.tenantId &&
        e.ingressId === receiver.ingressId,
    );
    if (input.serialized === undefined) {
      // A tenant with any required ingress cannot use an unlisted/optional ingress
      // as a legacy escape. Adapters still must call this shared primitive.
      const tenantRequires = registry.enrollments.some(
        (e) =>
          e.receiverId === receiver.receiverId && e.tenantId === receiver.tenantId && e.required,
      );
      if (tenantRequires || enrollment?.required) refuse('missing-assertion');
      return { status: 'legacy' };
    }
    const envelope = parseAssertion(input.serialized);
    const p = envelope.payload;
    const authority = resolveAuthority(p, registry, receiver);
    checkCandidate(p, candidate);
    checkTime(p, authority.key, receiver.now);
    const key = createPublicKey({
      key: Buffer.from('302a300506032b6570032100' + authority.key.publicKeyHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    if (
      !verify(
        null,
        sourceClassificationSigningBytes(p),
        key,
        Buffer.from(envelope.signature, 'hex'),
      )
    )
      refuse('invalid-signature');
    return {
      status: 'verified',
      minimumSensitivity: authority.profile.minimumSensitivity,
      assertionDigest: classificationHash(sourceClassificationSigningBytes(p).toString('utf8')),
      profileDigest: p.profileDigest,
      registryDigest: classificationHash(
        'bbb-source-classification-registry:v1\0' + classificationCanonicalJson(registry),
      ),
      enrollmentRevision: authority.enrollment.revision,
      replayIdentity: classificationHash(
        classificationCanonicalJson([p.receiverId, p.tenantId, p.producerId, p.assertionId]),
      ),
    };
  } catch (error) {
    return { status: 'refused', reason: error instanceof Refusal ? error.reason : 'invalid-input' };
  }
}
