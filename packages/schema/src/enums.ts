import { z } from 'zod';

export const MemorySource = z.enum(['claude_session', 'manual', 'import', 'mcp']);
export type MemorySource = z.infer<typeof MemorySource>;

export const TrustLevel = z.enum(['high', 'medium', 'low', 'untrusted']);
export type TrustLevel = z.infer<typeof TrustLevel>;

export const MemoryCategory = z.enum([
  'decision',
  'pattern',
  'convention',
  'architecture',
  'troubleshooting',
  'onboarding',
  'reference',
]);
export type MemoryCategory = z.infer<typeof MemoryCategory>;

export const MemoryLifecycleState = z.enum(['active', 'deprecated', 'superseded', 'archived']);
export type MemoryLifecycleState = z.infer<typeof MemoryLifecycleState>;

export const CandidateStatus = z.literal('inbox');
export type CandidateStatus = z.infer<typeof CandidateStatus>;

export const SearchScope = z.enum(['curated', 'all', 'inbox', 'archived']).default('curated');
export type SearchScope = z.infer<typeof SearchScope>;

export const PolicyRuleType = z.enum([
  'secret_detection',
  'dedup_check',
  'relevance_score',
  'content_length',
  'source_trust',
  'tenant_match',
  'sensitivity_gate',
  'content_sanitization',
]);
export type PolicyRuleType = z.infer<typeof PolicyRuleType>;

export const PolicyRuleAction = z.enum(['reject', 'flag', 'approve', 'require_review']);
export type PolicyRuleAction = z.infer<typeof PolicyRuleAction>;

export const AuditAction = z.enum([
  'promoted',
  'demoted',
  'superseded',
  'archived',
  'deleted',
  'searched',
  'exported',
  // Evidence Bundle emission on a curation/promotion cycle (IEP unification
  // thesis, DR-010 Q3). Added for the eval-surface emit path (bead tr08.15/.17/.19).
  'eval-result',
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const Confidence = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof Confidence>;

export const Sensitivity = z.enum(['public', 'internal', 'confidential', 'restricted']);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const AuthorType = z.enum(['human', 'ai', 'system']);
export type AuthorType = z.infer<typeof AuthorType>;

export const LinkType = z.enum([
  'relates_to',
  'supersedes',
  'contradicts',
  'depends_on',
  'part_of',
]);
export type LinkType = z.infer<typeof LinkType>;

export const LinkSource = z.enum(['curator', 'import', 'manual', 'mcp']);
export type LinkSource = z.infer<typeof LinkSource>;

export const ImportBatchStatus = z.enum(['active', 'completed', 'rolled_back']);
export type ImportBatchStatus = z.infer<typeof ImportBatchStatus>;
