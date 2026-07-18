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
export type { CitedHitMetadata } from './freshness.js';
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
