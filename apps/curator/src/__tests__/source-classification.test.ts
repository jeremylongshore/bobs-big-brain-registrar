import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeCandidate } from './fixtures.js';
import { verifySourceClassification } from '../origin/source-classification.js';
import {
  classificationCanonicalJson as canonical,
  classificationHash as hash,
  signSourceClassification,
  sourceClassificationSigningBytes,
  sourceProfileDigest,
} from '../origin/source-classification-codec.js';
import type {
  SourceClassificationPayload,
  SourceClassificationProfile,
  SourceClassificationRegistry,
} from '../origin/source-classification-schema.js';

const keys = generateKeyPairSync('ed25519');
const publicKeyHex = keys.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('hex');
function fixture() {
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
function run(
  f = fixture(),
  serialized: string | undefined = signSourceClassification(f.payload, keys.privateKey),
) {
  return verifySourceClassification({ ...f, serialized });
}
function missing(f = fixture()) {
  return verifySourceClassification({ ...f, serialized: undefined });
}

describe('source classification pure verification', () => {
  it('returns receiver-owned floor and bound digests without changing inputs', () => {
    const f = fixture(),
      before = structuredClone(f);
    const result = run(f);
    expect(result).toMatchObject({
      status: 'verified',
      minimumSensitivity: 'confidential',
      enrollmentRevision: 1,
      profileDigest: f.payload.profileDigest,
    });
    expect(f).toEqual(before);
    expect(JSON.stringify(result)).not.toContain(f.candidate.content);
    expect(run(f)).toEqual(result);
  });
  it('pins canonical profile bytes and explicit null representation', () => {
    const profile = fixture().registry.profiles[0]!;
    expect(canonical(profile)).toBe(
      '{"context":{"channel":"private","principalBinding":"principal-one-v1","repository":"repo-one","source":"manual"},"id":"private-notes","minimumSensitivity":"confidential","producerId":"collector","receiverId":"registrar","revision":1,"tenantId":"synthetic"}',
    );
    const p = fixture().payload;
    const bytes = sourceClassificationSigningBytes(p);
    expect(canonical(p)).toBe(
      '{"assertionId":"22222222-2222-4222-8222-222222222222","candidateId":"11111111-1111-4111-8111-111111111111","capturedAt":"2026-11-22T09:00:00.000Z","contentHash":"e113d93bfb652a0106f0d167ac129034e36080575613b66977cdc3de7b132726","context":{"channel":"private","principalBinding":"principal-one-v1","repository":"repo-one","source":"manual"},"expiresAt":"2026-11-22T09:10:00.000Z","issuedAt":"2026-11-22T09:01:00.000Z","keyId":"key-one","producerId":"collector","profileDigest":"79002b7c73cd93be2280ac0c97565166cdf2981817b9bcf0ef0fc8a3c9a07980","profileId":"private-notes","profileRevision":1,"purpose":"source-classification-assertion-v1","receiverId":"registrar","tenantId":"synthetic","titleHash":"21cc305095786cd35cdd0e43b4ab2d5b032f95b8e692ab97dcfda3bae2c12d24","version":1}',
    );
    expect(bytes.toString()).toBe('bbb-source-classification-assertion:v1\0' + canonical(p));
    expect(canonical({ b: null, a: 1 })).toBe('{"a":1,"b":null}');
  });
  const mutations: [string, unknown][] = [
    ['version', 2],
    ['purpose', 'snapshot-v1'],
    ['assertionId', '33333333-3333-4333-8333-333333333333'],
    ['producerId', 'other'],
    ['keyId', 'other'],
    ['receiverId', 'other'],
    ['tenantId', 'other'],
    ['candidateId', '33333333-3333-4333-8333-333333333333'],
    ['capturedAt', '2026-11-22T09:00:01.000Z'],
    ['contentHash', 'a'.repeat(64)],
    ['titleHash', 'b'.repeat(64)],
    ['profileId', 'other'],
    ['profileRevision', 2],
    ['profileDigest', 'c'.repeat(64)],
    ['issuedAt', '2026-11-22T09:01:01.000Z'],
    ['expiresAt', '2026-11-22T09:09:00.000Z'],
    ['context.source', 'import'],
    ['context.channel', 'public'],
    ['context.repository', null],
    ['context.principalBinding', null],
  ];
  it.each(mutations)('refuses tampering with signed %s', (field, value) => {
    const f = fixture();
    const envelope = JSON.parse(signSourceClassification(f.payload, keys.privateKey));
    const [top, nested] = field.split('.');
    if (nested) envelope.payload[top!][nested] = value;
    else envelope.payload[top!] = value;
    expect(run(f, canonical(envelope)).status).toBe('refused');
  });
  it.each(['content', 'title', 'id', 'tenantId', 'source', 'capturedAt'] as const)(
    'refuses changed candidate %s with intact signed evidence',
    (field) => {
      const f = fixture(),
        wire = signSourceClassification(f.payload, keys.privateKey);
      const changes = {
        content: 'changed',
        title: 'changed',
        id: '33333333-3333-4333-8333-333333333333',
        tenantId: 'other',
        source: 'import',
        capturedAt: '2026-11-22T09:00:01.000Z',
      };
      Object.assign(f.candidate, { [field]: changes[field] });
      expect(run(f, wire)).toEqual({ status: 'refused', reason: 'binding-mismatch' });
    },
  );
  it('unsigned author/role/path labels cannot lower the authenticated profile floor', () => {
    const f = fixture();
    f.candidate.metadata.proposedByRole = 'admin';
    f.candidate.metadata.filePaths = ['public'];
    f.candidate.author = { type: 'human', id: 'director', name: 'Synthetic' };
    expect(run(f)).toMatchObject({ status: 'verified', minimumSensitivity: 'confidential' });
  });
  it.each(['channel', 'repository', 'principalBinding', 'source'] as const)(
    'refuses producer-signed invented context %s outside current profile',
    (field) => {
      const f = fixture();
      Object.assign(f.payload.context, { [field]: field === 'source' ? 'import' : 'invented' });
      expect(run(f)).toEqual({ status: 'refused', reason: 'binding-mismatch' });
    },
  );
  it.each([
    'missing',
    'wrong-signer',
    'revoked',
    'scope',
    'receiver',
    'tenant',
    'producer',
    'id',
    'bytes',
  ] as const)('refuses %s key authority', (kind) => {
    const f = fixture(),
      key = f.registry.keys[0]!;
    switch (kind) {
      case 'missing':
        f.registry.keys = [];
        break;
      case 'wrong-signer':
        key.publicKeyHex = generateKeyPairSync('ed25519')
          .publicKey.export({ format: 'der', type: 'spki' })
          .subarray(-32)
          .toString('hex');
        break;
      case 'revoked':
        key.revoked = true;
        break;
      case 'scope':
        key.profileIds = ['other'];
        break;
      case 'receiver':
        key.receiverId = 'other';
        break;
      case 'tenant':
        key.tenantId = 'other';
        break;
      case 'producer':
        key.producerId = 'other';
        break;
      case 'id':
        key.id = 'other';
        break;
      case 'bytes':
        key.publicKeyHex = 'ab';
        break;
    }
    expect(run(f).status).toBe('refused');
  });
  it.each([
    'missing',
    'revision',
    'floor',
    'producer',
    'receiver',
    'tenant',
    'enrollment-scope',
    'enrollment-missing',
    'receiver-context',
    'ingress-context',
  ] as const)('refuses %s authority drift', (kind) => {
    const f = fixture(),
      profile = f.registry.profiles[0]!;
    switch (kind) {
      case 'missing':
        f.registry.profiles = [];
        break;
      case 'revision':
        profile.revision++;
        break;
      case 'floor':
        profile.minimumSensitivity = 'restricted';
        break;
      case 'producer':
        profile.producerId = 'other';
        break;
      case 'receiver':
        profile.receiverId = 'other';
        break;
      case 'tenant':
        profile.tenantId = 'other';
        break;
      case 'enrollment-scope':
        f.registry.enrollments[0]!.profileIds = ['other'];
        break;
      case 'enrollment-missing':
        f.registry.enrollments = [];
        break;
      case 'receiver-context':
        f.receiver.receiverId = 'other';
        break;
      case 'ingress-context':
        f.receiver.ingressId = 'other';
        break;
    }
    expect(run(f).status).toBe('refused');
  });
  it('requires fresh profile digest after prospective tightening or relaxation', () => {
    const f = fixture();
    for (const minimumSensitivity of ['restricted', 'public'] as const) {
      f.registry.profiles[0]!.minimumSensitivity = minimumSensitivity;
      f.registry.profiles[0]!.revision++;
      f.payload.profileRevision = f.registry.profiles[0]!.revision;
      f.payload.profileDigest = sourceProfileDigest(f.registry.profiles[0]!);
      expect(run(f)).toMatchObject({ status: 'verified', minimumSensitivity });
    }
    // Durable monotonic floors belong to the next task, not this prospective primitive.
  });
  it.each([
    'future',
    'expired',
    'zero-window',
    'too-long',
    'key-not-yet-valid',
    'key-expired',
    'future-capture',
    'invalid-clock',
  ] as const)('refuses %s timing', (kind) => {
    const f = fixture();
    switch (kind) {
      case 'future':
        f.payload.issuedAt = '2026-11-22T09:03:00.000Z';
        break;
      case 'expired':
        f.receiver.now = f.payload.expiresAt;
        break;
      case 'zero-window':
        f.payload.expiresAt = f.payload.issuedAt;
        break;
      case 'too-long':
        f.payload.expiresAt = '2026-11-22T10:01:00.001Z';
        break;
      case 'key-not-yet-valid':
        f.registry.keys[0]!.validFrom = f.receiver.now;
        break;
      case 'key-expired':
        f.registry.keys[0]!.validUntil = f.receiver.now;
        break;
      case 'future-capture':
        f.payload.capturedAt = '2026-11-22T09:01:00.001Z';
        f.candidate.capturedAt = f.payload.capturedAt;
        break;
      case 'invalid-clock':
        f.receiver.now = 'no-clock';
        break;
    }
    expect(run(f).status).toBe('refused');
  });
  it('allows exact issue time and maximum lifetime, with expiry exclusive', () => {
    const f = fixture();
    f.receiver.now = f.payload.issuedAt;
    f.payload.expiresAt = '2026-11-22T10:01:00.000Z';
    expect(run(f).status).toBe('verified');
  });
  it('requires evidence on enrolled tenant routes including unlisted and optional ingresses', () => {
    const f = fixture();
    expect(missing(f)).toEqual({ status: 'refused', reason: 'missing-assertion' });
    f.receiver.ingressId = 'unlisted';
    expect(missing(f).status).toBe('refused');
    f.registry.enrollments.push({
      ...f.registry.enrollments[0]!,
      ingressId: 'unlisted',
      required: false,
    });
    expect(missing(f).status).toBe('refused');
  });
  it('retains explicit unenrolled legacy mode but never ignores present invalid evidence', () => {
    const f = fixture();
    f.registry.enrollments[0]!.required = false;
    expect(missing(f)).toEqual({ status: 'legacy' });
    expect(run(f, 'bad')).toEqual({ status: 'refused', reason: 'invalid-input' });
    expect(run(f).status).toBe('verified');
    f.registry.enrollments = [];
    expect(missing(f)).toEqual({ status: 'legacy' });
    expect(run(f).status).toBe('refused');
  });
  it.each([
    'duplicate',
    'whitespace',
    'alternate-escape',
    'unknown-envelope',
    'unknown-payload',
    'unknown-context',
    'noncanonical-date',
    'missing-null',
    'oversized',
    'uppercase-signature',
    'wrong-domain',
  ] as const)('refuses %s wire encoding', (kind) => {
    const f = fixture();
    let wire = signSourceClassification(f.payload, keys.privateKey);
    const envelope = JSON.parse(wire);
    switch (kind) {
      case 'duplicate':
        wire = wire.replace('"version":1', '"version":1,"version":1');
        break;
      case 'whitespace':
        wire += '\n';
        break;
      case 'alternate-escape':
        wire = wire.replace('collector', '\\u0063ollector');
        break;
      case 'unknown-envelope':
        envelope.unknown = true;
        wire = canonical(envelope);
        break;
      case 'unknown-payload':
        envelope.payload.unknown = true;
        wire = canonical(envelope);
        break;
      case 'unknown-context':
        envelope.payload.context.unknown = true;
        wire = canonical(envelope);
        break;
      case 'noncanonical-date':
        envelope.payload.issuedAt = '2026-11-22T09:01:00Z';
        wire = canonical(envelope);
        break;
      case 'missing-null':
        delete envelope.payload.context.repository;
        wire = canonical(envelope);
        break;
      case 'oversized':
        wire = ' '.repeat(16_385);
        break;
      case 'uppercase-signature':
        envelope.signature = envelope.signature.toUpperCase();
        wire = canonical(envelope);
        break;
      case 'wrong-domain':
        envelope.signature = sign(
          null,
          Buffer.from('bbb-source-constraint-snapshot:v1\0' + canonical(f.payload)),
          keys.privateKey,
        ).toString('hex');
        wire = canonical(envelope);
        break;
    }
    expect(run(f, wire).status).toBe('refused');
  });
  it.each(['keys', 'profiles', 'enrollments'] as const)('refuses duplicate registry %s', (part) => {
    const f = fixture();
    f.registry[part] = [...f.registry[part], ...f.registry[part]] as never;
    expect(run(f)).toEqual({ status: 'refused', reason: 'invalid-input' });
  });
  it('refuses unknown or absent authority without recovering from candidate tags', () => {
    const f = fixture();
    expect(
      verifySourceClassification({
        ...f,
        registry: undefined,
        serialized: signSourceClassification(f.payload, keys.privateKey),
      }).status,
    ).toBe('refused');
    expect(
      verifySourceClassification({
        ...f,
        registry: { ...f.registry, version: 2 },
        serialized: undefined,
      }).status,
    ).toBe('refused');
  });
  it('exposes stable replay identity and distinct payload digests for later atomic settlement', () => {
    const f = fixture(),
      first = run(f);
    f.payload.expiresAt = '2026-11-22T09:09:00.000Z';
    const second = run(f);
    if (first.status !== 'verified' || second.status !== 'verified') throw new Error('fixture');
    expect(first.replayIdentity).toBe(second.replayIdentity);
    expect(first.assertionDigest).not.toBe(second.assertionDigest);
    f.payload.assertionId = '33333333-3333-4333-8333-333333333333';
    expect(run(f)).not.toMatchObject({ replayIdentity: first.replayIdentity });
  });

  it('accepts explicit absent optional source dimensions only when the profile agrees', () => {
    const f = fixture();
    f.payload.context.repository = null;
    f.payload.context.principalBinding = null;
    f.registry.profiles[0]!.context = structuredClone(f.payload.context);
    f.payload.profileDigest = sourceProfileDigest(f.registry.profiles[0]!);
    expect(run(f).status).toBe('verified');
  });
  it.each(['key', 'enrollment'] as const)('rejects duplicate %s profile scope', (kind) => {
    const f = fixture();
    const entry = kind === 'key' ? f.registry.keys[0]! : f.registry.enrollments[0]!;
    entry.profileIds.push(entry.profileIds[0]!);
    expect(run(f)).toEqual({ status: 'refused', reason: 'invalid-input' });
  });
  it.each(['content', 'title'] as const)(
    'refuses non-roundtrippable UTF-8 and oversized candidate %s',
    (field) => {
      const f = fixture();
      f.candidate[field] = '\ud800';
      f.payload[field === 'content' ? 'contentHash' : 'titleHash'] = hash(f.candidate[field]);
      expect(run(f).status).toBe('refused');
      f.candidate[field] = 'x'.repeat(1_048_577);
      f.payload[field === 'content' ? 'contentHash' : 'titleHash'] = hash(f.candidate[field]);
      expect(run(f).status).toBe('refused');
    },
  );
  it('rejects another key algorithm at minting', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(() => signSourceClassification(fixture().payload, other.privateKey)).toThrow('Ed25519');
  });
});
