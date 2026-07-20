export {
  MemorySource,
  TrustLevel,
  MemoryCategory,
  MemoryLifecycleState,
  CandidateStatus,
  SearchScope,
  PolicyRuleType,
  PolicyRuleAction,
  AuditAction,
  ProposerRole,
  Confidence,
  Sensitivity,
  AuthorType,
  LinkType,
  LinkSource,
  ImportBatchStatus,
} from './enums.js';

export {
  Uuid,
  Sha256Hash,
  IsoDatetime,
  NonEmptyString,
  SemVer,
  Tag,
  Author,
  TenantId,
  ContentMetadata,
} from './common.js';

export {
  PrePolicyFlags,
  MemoryCandidate,
  MEMORY_CANDIDATE_SCHEMA_VERSION,
  CandidateOrigin,
  OriginChannel,
} from './memory-candidate.js';
export { PolicyEvaluation, SupersessionLink, CuratedMemory } from './curated-memory.js';
export type { ActiveMemory, SupersededMemory } from './curated-memory.js';
export { PolicyRule, GovernancePolicy } from './governance-policy.js';
export { Pagination, SearchQuery, SearchHit, SearchResult } from './search.js';
export { AuditEvent } from './audit-event.js';

export {
  TransitionRequest,
  RecategorizeRequest,
  ALLOWED_TRANSITIONS,
  isTransitionAllowed,
  validateTransition,
  getAllowedTransitionsFrom,
} from './lifecycle.js';
export type { TransitionValidationResult } from './lifecycle.js';
