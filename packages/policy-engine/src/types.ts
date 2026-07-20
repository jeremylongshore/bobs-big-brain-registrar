import type {
  MemoryCandidate,
  GovernancePolicy,
  PolicyRule,
  MemoryCategory,
} from '@qmd-team-intent-kb/schema';

/** Result of evaluating a single rule against a candidate */
export interface RuleResult {
  ruleId: string;
  ruleType: string;
  outcome: 'pass' | 'fail' | 'flag';
  reason: string;
  score?: number; // for scoring rules (relevance, trust)
}

/**
 * The minimal projection of an ACTIVE curated memory that the
 * `contradiction_check` rule compares a candidate against (E1). Kept to
 * id + content so callers can hand the rule a cheap snapshot — the rule itself
 * stays pure and store-free; the caller that constructs the
 * {@link EvaluationContext} owns the query.
 */
export interface ActiveMemorySnapshot {
  id: string;
  content: string;
}

/** Context provided to rule evaluators */
export interface EvaluationContext {
  candidate: MemoryCandidate;
  policy: GovernancePolicy;
  existingHashes?: Set<string>; // for dedup checking
  tenantId?: string; // for tenant match validation
  /**
   * Injected lookup for `contradiction_check` (E1): return the ACTIVE curated
   * memories of the caller's tenant in the given category. Injected by whoever
   * constructs the context (curator / promotion service) so the rule stays a
   * pure function; when absent the rule passes vacuously, exactly like
   * `existingHashes` for dedup.
   */
  getActiveMemoriesInCategory?: (category: MemoryCategory) => readonly ActiveMemorySnapshot[];
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
  // ruleIds that flagged. Present on 'flagged' results, and ALSO on 'rejected'
  // results when a phase-1 contradiction rule (or an earlier flag rule) fired
  // before the reject short-circuit (E1) — a reject never erases a flag.
  flaggedBy?: string[];
}
