// Compatibility surface; do not duplicate canonical serialization or signing.
export {
  SOURCE_CLASSIFICATION_DOMAIN,
  MAX_SOURCE_CLASSIFICATION_BYTES,
  MAX_SOURCE_CLASSIFICATION_LIFETIME_MS,
  classificationCanonicalJson,
  classificationHash,
  sourceProfileDigest,
  sourceClassificationSigningBytes,
  signSourceClassification,
} from '@qmd-team-intent-kb/schema/source-classification';
