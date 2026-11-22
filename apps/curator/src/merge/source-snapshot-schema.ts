import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CuratedMemory,
  IsoDatetime,
  Sensitivity,
  Sha256Hash,
  TenantId,
} from '@qmd-team-intent-kb/schema';

export const MAX_SOURCE_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_SNAPSHOT_ITEMS = 10_000;
export const SNAPSHOT_DOMAIN = 'bbb-source-constraint-snapshot:v1\0';

const sourceId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const tenantId = TenantId.refine((value) => value.trim() === value && value.length > 0);
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const SourceSnapshotOptions = z
  .object({
    sourceId,
    sourceTenantId: tenantId,
    destinationTenantId: tenantId,
    sequence,
    issuedAt: IsoDatetime,
    expiresAt: IsoDatetime,
  })
  .strict();
export type SourceSnapshotOptions = z.infer<typeof SourceSnapshotOptions>;

export const SourceSnapshotItem = z
  .object({
    memory: CuratedMemory,
    minimumSensitivity: Sensitivity,
    /** Digest of candidate-scoped source audit evidence; no raw audit details leave the source. */
    constraintEvidenceDigest: Sha256Hash,
  })
  .strict();
export type SourceSnapshotItem = z.infer<typeof SourceSnapshotItem>;

export const SourceSnapshotPayload = SourceSnapshotOptions.extend({
  version: z.literal(1),
  scope: z.literal('all-active-source-tenant-v1'),
  constraintModel: z.literal('registrar-sensitivity-floor-v1'),
  keyId: Sha256Hash,
  auditHead: Sha256Hash.nullable(),
  itemCount: z.number().int().min(0).max(MAX_SOURCE_SNAPSHOT_ITEMS),
  inventoryDigest: Sha256Hash,
  items: z.array(SourceSnapshotItem).max(MAX_SOURCE_SNAPSHOT_ITEMS),
}).strict();
export type SourceSnapshotPayload = z.infer<typeof SourceSnapshotPayload>;

export const SignedSourceSnapshot = z
  .object({
    payload: SourceSnapshotPayload,
    digest: Sha256Hash,
    signature: z.string().regex(/^[a-f0-9]{128}$/),
  })
  .strict();
export type SignedSourceSnapshot = z.infer<typeof SignedSourceSnapshot>;

/** Trusted caller input, loaded independently of the supplied artifact. Not an enrollment API. */
export const TrustedSourceCheckpoint = z
  .object({
    sourceId,
    sourceTenantId: tenantId,
    destinationTenantId: tenantId,
    keyId: Sha256Hash,
    publicKeyHex: z.string().regex(/^[a-f0-9]{88}$/),
    sequence,
    snapshotDigest: Sha256Hash,
    validFrom: IsoDatetime,
    validUntil: IsoDatetime,
    revoked: z.boolean(),
  })
  .strict();
export type TrustedSourceCheckpoint = z.infer<typeof TrustedSourceCheckpoint>;

export type SourceSnapshotRefusal =
  | 'invalid-input'
  | 'invalid-source'
  | 'invalid-signature'
  | 'untrusted-source'
  | 'stale-checkpoint'
  | 'snapshot-mismatch';

export class SourceSnapshotError extends Error {
  constructor(readonly code: SourceSnapshotRefusal) {
    super(`Source snapshot refused: ${code}`);
    this.name = 'SourceSnapshotError';
  }
}

/** Sorted object keys; array order is part of this versioned contract. */
export function snapshotCanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown): unknown => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return item;
  });
}

/** Exact canonical JSON digest, distinct from normalized memory-content hashing. */
export function sourceSnapshotDigest(value: unknown): string {
  return createHash('sha256')
    .update(SNAPSHOT_DOMAIN)
    .update(snapshotCanonicalJson(value))
    .digest('hex');
}

export function snapshotSigningBytes(payload: SourceSnapshotPayload): Buffer {
  return Buffer.from(SNAPSHOT_DOMAIN + snapshotCanonicalJson(payload), 'utf8');
}
