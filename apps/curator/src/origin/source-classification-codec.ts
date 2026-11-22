import { createHash, sign, type KeyObject } from 'node:crypto';
import {
  SourceClassificationPayload,
  SourceClassificationProfile,
} from './source-classification-schema.js';

export const SOURCE_CLASSIFICATION_DOMAIN = 'bbb-source-classification-assertion:v1\0';
export const MAX_SOURCE_CLASSIFICATION_BYTES = 16_384;
export const MAX_SOURCE_CLASSIFICATION_LIFETIME_MS = 3_600_000;

/** Closed protocol values only: ASCII keys, integers, strings, arrays and explicit nulls. */
export function classificationCanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown): unknown => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return item;
  });
}
export function classificationHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function sourceProfileDigest(profile: SourceClassificationProfile): string {
  return classificationHash(
    'bbb-source-classification-profile:v1\0' +
      classificationCanonicalJson(SourceClassificationProfile.parse(profile)),
  );
}
export function sourceClassificationSigningBytes(payload: SourceClassificationPayload): Buffer {
  return Buffer.from(
    SOURCE_CLASSIFICATION_DOMAIN +
      classificationCanonicalJson(SourceClassificationPayload.parse(payload)),
    'utf8',
  );
}
/** Pure producer primitive. Adapter must select a profile from authenticated source evidence. */
export function signSourceClassification(
  payload: SourceClassificationPayload,
  privateKey: KeyObject,
): string {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Source classification requires an Ed25519 private key');
  }
  const parsed = SourceClassificationPayload.parse(payload);
  return classificationCanonicalJson({
    payload: parsed,
    signature: sign(null, sourceClassificationSigningBytes(parsed), privateKey).toString('hex'),
  });
}
