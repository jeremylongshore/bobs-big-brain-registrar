import { generateKeyPairSync } from 'node:crypto';
import { makeCandidate } from './fixtures.js';
import {
  classificationHash as hash,
  sourceProfileDigest,
} from '../origin/source-classification-codec.js';
import type {
  SourceClassificationProfile,
  SourceClassificationPayload,
  SourceClassificationRegistry,
} from '../origin/source-classification-schema.js';
const keys = generateKeyPairSync('ed25519');
const publicKeyHex = keys.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('hex');
export function makeSourceGovernanceFixture() {
  const candidate = makeCandidate({
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'synthetic',
    source: 'manual',
    content: 'Synthetic private planning',
    title: 'Planning',
    capturedAt: '2026-11-22T09:00:00.000Z',
  });
  const profile: SourceClassificationProfile = {
    id: 'private-notes',
    revision: 1,
    producerId: 'collector',
    receiverId: 'registrar',
    tenantId: candidate.tenantId,
    context: {
      source: 'manual',
      channel: 'private',
      repository: 'repo-one',
      principalBinding: 'principal-one-v1',
    },
    minimumSensitivity: 'confidential',
  };
  const payload: SourceClassificationPayload = {
    version: 1,
    purpose: 'source-classification-assertion-v1',
    assertionId: '22222222-2222-4222-8222-222222222222',
    producerId: profile.producerId,
    keyId: 'key-one',
    receiverId: profile.receiverId,
    tenantId: candidate.tenantId,
    candidateId: candidate.id,
    capturedAt: candidate.capturedAt,
    contentHash: hash(candidate.content),
    titleHash: hash(candidate.title),
    context: structuredClone(profile.context),
    profileId: profile.id,
    profileRevision: 1,
    profileDigest: sourceProfileDigest(profile),
    issuedAt: '2026-11-22T09:01:00.000Z',
    expiresAt: '2026-11-22T09:10:00.000Z',
  };
  const registry: SourceClassificationRegistry = {
    version: 1,
    revision: 1,
    profiles: [profile],
    keys: [
      {
        id: payload.keyId,
        producerId: payload.producerId,
        receiverId: payload.receiverId,
        tenantId: payload.tenantId,
        publicKeyHex,
        profileIds: [profile.id],
        validFrom: '2026-11-22T00:00:00.000Z',
        validUntil: '2026-11-23T00:00:00.000Z',
        revoked: false,
      },
    ],
    enrollments: [
      {
        receiverId: payload.receiverId,
        tenantId: payload.tenantId,
        ingressId: 'api',
        revision: 1,
        required: true,
        profileIds: [profile.id],
      },
    ],
  };
  return {
    keys,
    candidate,
    payload,
    registry,
    receiver: {
      receiverId: payload.receiverId,
      tenantId: payload.tenantId,
      ingressId: 'api',
      now: '2026-11-22T09:02:00.000Z',
    },
  };
}
