import { z } from 'zod';
import { MemorySource, Sensitivity } from './enums.js';
import { Sha256Hash, Uuid } from './common.js';

// This independent protocol does not extend or replace CandidateOrigin/spool v1.
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const instant = z
  .string()
  .datetime()
  .refine((s) => {
    const time = Date.parse(s);
    return Number.isFinite(time) && new Date(time).toISOString() === s;
  });
export const SourceClassificationContext = z
  .object({
    source: MemorySource,
    channel: id,
    repository: id.nullable(),
    principalBinding: id.nullable(),
  })
  .strict();
export const SourceClassificationProfile = z
  .object({
    id,
    revision,
    producerId: id,
    receiverId: id,
    tenantId: id,
    context: SourceClassificationContext,
    minimumSensitivity: Sensitivity,
  })
  .strict();
export type SourceClassificationProfile = z.infer<typeof SourceClassificationProfile>;
export const SourceClassificationPayload = z
  .object({
    version: z.literal(1),
    purpose: z.literal('source-classification-assertion-v1'),
    assertionId: Uuid,
    producerId: id,
    keyId: id,
    receiverId: id,
    tenantId: id,
    candidateId: Uuid,
    capturedAt: instant,
    contentHash: Sha256Hash,
    titleHash: Sha256Hash,
    context: SourceClassificationContext,
    profileId: id,
    profileRevision: revision,
    profileDigest: Sha256Hash,
    issuedAt: instant,
    expiresAt: instant,
  })
  .strict();
export type SourceClassificationPayload = z.infer<typeof SourceClassificationPayload>;
export const SignedSourceClassification = z
  .object({
    payload: SourceClassificationPayload,
    signature: z.string().regex(/^[a-f0-9]{128}$/),
  })
  .strict();
export const SourceClassificationKey = z
  .object({
    id,
    producerId: id,
    receiverId: id,
    tenantId: id,
    // Raw 32-byte Ed25519 public key; DER prefix is fixed by the verifier.
    publicKeyHex: z.string().regex(/^[a-f0-9]{64}$/),
    profileIds: z.array(id).min(1).max(256),
    validFrom: instant,
    validUntil: instant,
    revoked: z.boolean(),
  })
  .strict();
export const SourceClassificationEnrollment = z
  .object({
    receiverId: id,
    tenantId: id,
    ingressId: id,
    revision,
    required: z.boolean(),
    profileIds: z.array(id).min(1).max(256),
  })
  .strict();
export const SourceClassificationRegistry = z
  .object({
    version: z.literal(1),
    revision,
    profiles: z.array(SourceClassificationProfile).max(256),
    keys: z.array(SourceClassificationKey).max(256),
    enrollments: z.array(SourceClassificationEnrollment).max(256),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (
      !unique(registry.profiles.map((p) => p.id)) ||
      !unique(registry.keys.map((k) => `${k.producerId}/${k.id}`)) ||
      !unique(registry.enrollments.map((e) => `${e.receiverId}/${e.tenantId}/${e.ingressId}`)) ||
      registry.keys.some((k) => !unique(k.profileIds)) ||
      registry.enrollments.some((e) => !unique(e.profileIds))
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate authority identity' });
  });
export type SourceClassificationRegistry = z.infer<typeof SourceClassificationRegistry>;
/** Receiver-owned inputs, never selected by an assertion or request body. */
export const SourceClassificationReceiver = z
  .object({
    receiverId: id,
    tenantId: id,
    ingressId: id,
    now: instant,
  })
  .strict();
