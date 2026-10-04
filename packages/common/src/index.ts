export type { Result } from './result.js';
export { ok, err } from './result.js';
export { computeContentHash, computeFileHash } from './hash.js';
export {
  SPOOL_UUID_NAMESPACE,
  uuidV5,
  deriveCandidateId,
  deriveMemoryId,
  deriveAuditEventId,
  derivePolicyEvaluationId,
  deriveLinkId,
} from './uuid-v5.js';
export { DEFAULT_TEAMKB_BASE, getTeamKbBasePath, resolveTeamKbPath } from './paths.js';
export {
  ORIGIN_SECRET_FILENAME,
  ORIGIN_SECRET_ENV,
  ORIGIN_SECRET_UNAVAILABLE_WARNING,
  UNATTESTED_CHANNEL,
  ORIGIN_TOKEN_HASH_SURFACE_LEN,
  buildOriginTokenPayload,
  mintOriginToken,
  verifyOriginToken,
  hashOriginToken,
  loadOriginSecret,
  loadOrCreateOriginSecret,
  originSecretPath,
} from './origin-token.js';
export type { OriginTokenIdentity } from './origin-token.js';
export { isPathSafe } from './path-safety.js';
export type { PathSafetyResult } from './path-safety.js';
export {
  computeFreshnessScore,
  CATEGORY_BOOST,
  rerankSearchHits,
  extractMemoryIdFromCitation,
  rerankCitedHits,
  isSearchVisibleSensitivity,
  SEARCH_HIDDEN_SENSITIVITY,
} from './freshness.js';
export type { CitedHitMetadata, RerankOptions } from './freshness.js';
export {
  DEFAULT_AUDIENCE,
  AUDIENCE_RANK,
  READER_ROLE_CLEARANCE,
  resolveAudience,
  isAudienceVisibleToRole,
  isExportableAudience,
  readerRoleFor,
} from './audience.js';
export type { ReaderRole } from './audience.js';
export {
  LIFECYCLE_DEPRECATED_FACTOR,
  LIFECYCLE_ARCHIVED_FACTOR,
  HISTORICAL_RECORD_FACTOR,
  HISTORICAL_TITLE_PATTERN,
  HISTORY_INTENT_PATTERN,
  hasHistoryIntent,
  isHistoricalRecordTitle,
  lifecycleFactor,
  computeRerankPolicyFactors,
} from './rerank-policy.js';
export type { RerankPolicyInput, RerankPolicyFactors } from './rerank-policy.js';
export {
  scanForDisclosure,
  scanDisclosureFields,
  assertDisclosureClean,
  collectFreeTextFields,
  ENUM_CONSTRAINED_FIELDS,
  normalizeForScan,
  DisclosureRejectedError,
  COMPENSATION_TERMS_PATTERN,
  RATIO_SPLIT_PATTERN,
  COMP_CONTEXT_PATTERN,
  PII_PATTERN,
  SECRET_PATTERNS,
} from './disclosure-filter.js';
export type {
  DisclosureCategory,
  DisclosureViolation,
  DisclosureScanInput,
} from './disclosure-filter.js';
