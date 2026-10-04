import { classifyContent } from '@qmd-team-intent-kb/claude-runtime';
import {
  AUDIENCE_RANK,
  resolveAudience,
  validateAudienceNarrowing,
} from '@qmd-team-intent-kb/common';
import type { MemoryCandidate, PolicyRule } from '@qmd-team-intent-kb/schema';
import type { EvaluationContext, RuleResult } from '../types.js';

/** Audience recommended for content carrying credential-shaped material. */
const DEFAULT_CREDENTIALS_AUDIENCE = 'owner';
/** Audience recommended for content carrying PII-shaped material. */
const DEFAULT_PII_AUDIENCE = 'admins';
/** Audience recommended for content with neither: the tenant-wide default. */
const BASELINE_AUDIENCE = 'tenant';

/** Why a narrower audience is (or is not) recommended. */
export type AudienceRecommendationBasis = 'credentials' | 'pii' | 'none';

/** The deterministic audience recommendation for one piece of content. */
export interface AudienceRecommendation {
  /** The audience the claim effectively declares (absent -> `tenant`). */
  declared: string;
  /** The widest audience the content's classification supports. */
  recommended: string;
  /** True when `declared` is strictly wider than `recommended`. */
  shouldNarrow: boolean;
  /** Which content class drove the recommendation. */
  basis: AudienceRecommendationBasis;
  /** Pattern IDS that fired — never the matched text. */
  matchedPatterns: string[];
}

/** Tiers a rule parameter may name; anything else falls back to the default. */
function parseTier(value: unknown, fallback: string): string {
  return typeof value === 'string' && Object.hasOwn(AUDIENCE_RANK, value) ? value : fallback;
}

/**
 * Recommend an audience for `content` against the audience it declares (Epic K
 * bead K3). Pure and deterministic: the same regex classifier the sensitivity
 * gate uses decides the content class, and a fixed table maps the class to a
 * tier — credentials -> `owner`, PII -> `admins`, otherwise `tenant`.
 *
 * It only ever RECOMMENDS. It never writes an audience and never widens one: a
 * claim already at or below the recommended tier yields `shouldNarrow: false`.
 * The governed write is `narrowAudience` (curator) — a human-initiated,
 * receipted act.
 */
export function recommendAudience(
  content: string,
  declaredAudience: string | null | undefined,
  tiers: { credentials?: unknown; pii?: unknown } = {},
): AudienceRecommendation {
  const classification = classifyContent(content);
  const declared = resolveAudience(declaredAudience);

  let basis: AudienceRecommendationBasis = 'none';
  let recommended = BASELINE_AUDIENCE;
  if (classification.hasCredentials) {
    basis = 'credentials';
    recommended = parseTier(tiers.credentials, DEFAULT_CREDENTIALS_AUDIENCE);
  } else if (classification.hasPii) {
    basis = 'pii';
    recommended = parseTier(tiers.pii, DEFAULT_PII_AUDIENCE);
  }

  return {
    declared,
    recommended,
    shouldNarrow: validateAudienceNarrowing(declared, recommended).valid,
    basis,
    matchedPatterns: classification.matchedPatterns.filter((id) => id !== 'internal-path'),
  };
}

/**
 * Rule evaluator that flags a candidate whose declared audience is WIDER than
 * its content calls for (Epic K bead K3, decision `000-docs/053-AT-DECR`).
 *
 * ## Behavioural contract
 *
 * - Returns only `pass` or `flag`, NEVER `fail` — so no `action: 'reject'`
 *   configuration can turn a recommendation into a rejection.
 * - Recommends; does not write. The candidate's `metadata.audience` is left
 *   exactly as declared (KR8.1: no rule infers or writes an audience).
 * - An unrecognized declared audience is flagged rather than silently treated
 *   as tenant-wide (fail-closed: an unknown tier is a data fault to review).
 * - The reason names pattern ids only, never the matched text.
 *
 * It is measured on its own hand-labeled fixture and its precision/recall are
 * reported separately from the disclosure rules (KR8.2).
 *
 * Parameters:
 * - credentialsAudience: tier recommended for credential-shaped content (default `owner`).
 * - piiAudience: tier recommended for PII-shaped content (default `admins`).
 */
export function evaluateAudienceNarrowing(
  candidate: MemoryCandidate,
  rule: PolicyRule,
  _context: EvaluationContext,
): RuleResult {
  const declared = resolveAudience(candidate.metadata.audience);
  if (!Object.hasOwn(AUDIENCE_RANK, declared)) {
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome: 'flag',
      reason: `Declared audience "${declared}" is not a known tier — review before promotion`,
    };
  }

  const recommendation = recommendAudience(candidate.content, declared, {
    credentials: rule.parameters['credentialsAudience'],
    pii: rule.parameters['piiAudience'],
  });

  if (!recommendation.shouldNarrow) {
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome: 'pass',
      reason: `Declared audience '${declared}' is not wider than the content calls for ('${recommendation.recommended}')`,
    };
  }

  return {
    ruleId: rule.id,
    ruleType: rule.type,
    outcome: 'flag',
    reason:
      `Declared audience '${declared}' is wider than the content calls for: ` +
      `${recommendation.basis} detected (patterns: ${recommendation.matchedPatterns.join(', ')}) — ` +
      `recommend narrowing to '${recommendation.recommended}'. Recommendation only; nothing was changed.`,
  };
}
