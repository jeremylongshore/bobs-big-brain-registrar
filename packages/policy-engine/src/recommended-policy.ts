/**
 * The canonical RECOMMENDED governance policy and a completeness gate
 * (bead qmd-team-intent-kb-5bm.2).
 *
 * ## Why this exists
 *
 * The ontology audit (2026-07-17) found the LIVE policy enabled only 2 of the 8
 * registered rules — `secret_detection` and `content_length`. The other six
 * (`source_trust`, `sensitivity_gate`, `relevance_score`, `dedup_check`,
 * `tenant_match`, `content_sanitization`) exist in {@link RULE_REGISTRY} and are
 * fully implemented, but the pipeline only runs the rules a policy names, so they
 * gated NOTHING in production. That silent dormancy is a direct contributor to the
 * 2026-07-16 whole-machine digestion promoting ~15k unfiltered candidates.
 *
 * This module makes "a complete policy" a code-level source of truth, and adds a
 * gate so a rule can never again sit registered-but-dormant unnoticed:
 *
 *   - {@link RECOMMENDED_POLICY_RULES} names EVERY registered rule type. A rule
 *     added to the registry with no entry here fails {@link findUncoveredRuleTypes}
 *     (asserted in CI), so the author must make a deliberate enable/waive choice.
 *   - Actions are conservative: the three hard boundaries — `secret_detection`,
 *     `content_length`, `tenant_match` — `reject`; everything else `flag` (records
 *     signal and continues, never blocks a legitimate promotion). This is the
 *     "flag at minimum" the audit recommended; an operator can tighten a flag to a
 *     reject deliberately.
 *
 * Applying this to the LIVE brain is a separate, reversible operational step
 * (it changes what gets flagged/rejected on the running store) — this module only
 * defines the recommended shape and the gate; it does not mutate any live policy.
 *
 * @module recommended-policy
 */
import { randomUUID } from 'node:crypto';
import { GovernancePolicy, type PolicyRule, type PolicyRuleType } from '@qmd-team-intent-kb/schema';
import { RULE_REGISTRY } from './rules/index.js';

/**
 * The recommended rule set — one entry per registered {@link PolicyRuleType}.
 *
 * Ordered by priority: hard security/quality boundaries first (lower priority
 * number runs first and can short-circuit on reject), advisory flags after.
 * Parameters left `{}` fall back to each rule's built-in defaults
 * (`content_length` pins `min: 25`, the value the live policy already used).
 */
export const RECOMMENDED_POLICY_RULES: readonly PolicyRule[] = [
  {
    id: 'rec-secret-detection',
    type: 'secret_detection',
    action: 'reject',
    enabled: true,
    priority: 0,
    parameters: {},
    description: 'Reject candidates containing secrets/credentials.',
  },
  {
    id: 'rec-content-length',
    type: 'content_length',
    action: 'reject',
    enabled: true,
    priority: 1,
    parameters: { min: 25 },
    description: 'Reject candidates below the minimum meaningful length.',
  },
  {
    id: 'rec-tenant-match',
    type: 'tenant_match',
    action: 'reject',
    enabled: true,
    priority: 2,
    parameters: {},
    description: 'Reject a candidate whose tenant does not match its target.',
  },
  {
    id: 'rec-source-trust',
    type: 'source_trust',
    action: 'flag',
    enabled: true,
    priority: 3,
    parameters: {},
    description: 'Flag candidates below the minimum source trust level.',
  },
  {
    id: 'rec-relevance-score',
    type: 'relevance_score',
    action: 'flag',
    enabled: true,
    priority: 4,
    parameters: {},
    description: 'Flag low-relevance candidates for review.',
  },
  {
    id: 'rec-sensitivity-gate',
    type: 'sensitivity_gate',
    action: 'flag',
    enabled: true,
    priority: 5,
    parameters: {},
    description: 'Flag candidates whose classified sensitivity warrants review.',
  },
  {
    id: 'rec-dedup-check',
    type: 'dedup_check',
    action: 'flag',
    enabled: true,
    priority: 6,
    parameters: {},
    description: 'Flag likely-duplicate candidates.',
  },
  {
    id: 'rec-content-sanitization',
    type: 'content_sanitization',
    action: 'flag',
    enabled: true,
    priority: 7,
    parameters: {},
    description: 'Flag content that required sanitization.',
  },
];

/**
 * Build a full {@link GovernancePolicy} from {@link RECOMMENDED_POLICY_RULES} for a
 * given tenant. `now` is injected (no ambient clock) so the result is
 * deterministic and testable.
 */
export function buildRecommendedPolicy(tenantId: string, now: string): GovernancePolicy {
  return GovernancePolicy.parse({
    id: randomUUID(),
    name: 'Recommended Governance Policy',
    tenantId,
    rules: RECOMMENDED_POLICY_RULES,
    enabled: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Return every registered {@link PolicyRuleType} that the given policy does NOT
 * actively enforce (absent, or present but `enabled: false`). An empty result
 * means the policy covers the full registry — no rule is silently dormant.
 *
 * This is the anti-dormancy gate: CI asserts the RECOMMENDED policy leaves none
 * uncovered, and an operator can run it against the live policy to see exactly
 * which rules are inert.
 */
export function findUncoveredRuleTypes(policy: GovernancePolicy): PolicyRuleType[] {
  const enabled = new Set(policy.rules.filter((r) => r.enabled).map((r) => r.type));
  return (Object.keys(RULE_REGISTRY) as PolicyRuleType[]).filter((t) => !enabled.has(t)).sort();
}

/**
 * Assert a policy actively enforces every registered rule, or the caller has
 * EXPLICITLY waived the gaps. Throws listing the dormant rules otherwise. Use in
 * a doctor/health check or a policy-load path so a new registered rule can never
 * silently gate nothing.
 */
export function assertPolicyCompleteness(
  policy: GovernancePolicy,
  waived: readonly PolicyRuleType[] = [],
): void {
  const uncovered = findUncoveredRuleTypes(policy).filter((t) => !waived.includes(t));
  if (uncovered.length > 0) {
    throw new Error(
      `Policy "${policy.name}" leaves ${uncovered.length} registered rule(s) dormant ` +
        `(not enabled, not waived): ${uncovered.join(', ')}. Enable them in the policy ` +
        `or waive them explicitly.`,
    );
  }
}
