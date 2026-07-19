import type { MemoryCandidate, GovernancePolicy, PolicyRule } from '@qmd-team-intent-kb/schema';
import type { DeterministicScore } from './deterministic-score.js';

/** Result of evaluating a single rule against a candidate */
export interface RuleResult {
  ruleId: string;
  ruleType: string;
  outcome: 'pass' | 'fail' | 'flag';
  reason: string;
  // Seam firewall (B2): a govern score is a DeterministicScore, never a raw number.
  // A retrieval/rerank/embedding score (a plain number) cannot be assigned here; the
  // compiler rejects it. Mint one only via deterministicScore() from a deterministic rule.
  score?: DeterministicScore; // for scoring rules (relevance, trust)
}

/** Context provided to rule evaluators */
export interface EvaluationContext {
  candidate: MemoryCandidate;
  policy: GovernancePolicy;
  existingHashes?: Set<string>; // for dedup checking
  tenantId?: string; // for tenant match validation
}

/** Function signature for a rule evaluator */
export type RuleEvaluator = (
  candidate: MemoryCandidate,
  rule: PolicyRule,
  context: EvaluationContext,
) => RuleResult;

/** Result of running the full pipeline */
export interface PipelineResult {
  candidateId: string;
  outcome: 'approved' | 'rejected' | 'flagged';
  evaluations: RuleResult[];
  rejectedBy?: string; // ruleId that caused rejection
  flaggedBy?: string[]; // ruleIds that flagged
}
