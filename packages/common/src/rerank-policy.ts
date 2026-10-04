/**
 * Deterministic rerank policy: lifecycle demotion + historical-record demotion.
 *
 * Added for compile-then-govern-39z.13. Measured on the live brain (2026-10-03):
 * for GCP / Terraform / deploy queries, point-in-time records (AARs, audits,
 * status reports) outranked the current owner decision ("GCP fully exited"),
 * and a `deprecated` memory ranked like an active one. Both are fixed here as
 * pure multipliers applied next to freshness x category boost. No model, no
 * network, no randomness: same inputs always give the same factor.
 */

/** Lifecycle multiplier: a deprecated memory is retired guidance, not current truth. */
export const LIFECYCLE_DEPRECATED_FACTOR = 0.5;

/**
 * Lifecycle multiplier for archived/superseded memories. Normal search paths
 * exclude these; if one ever surfaces (archived scope, a stale index) it must
 * sit well below any active hit.
 */
export const LIFECYCLE_ARCHIVED_FACTOR = 0.2;

/**
 * Historical-record multiplier. AARs, audits and status reports describe a
 * moment in time; the imported-document `updatedAt` is the import time, so
 * freshness cannot demote them. A mild 0.7 (not 0.2) keeps them findable
 * while letting a current decision (category boost 1.2) win a close contest.
 */
export const HISTORICAL_RECORD_FACTOR = 0.7;

/**
 * Title patterns that mark a point-in-time record. Matched case-insensitively
 * on word boundaries. `audit` is excluded when it names a mechanism
 * ("audit log", "audit trail", "audit chain") rather than an audit report.
 */
export const HISTORICAL_TITLE_PATTERN =
  /\b(?:aar|after[\s-]+action|post[\s-]?mortem|retrospective|audit(?![\s-]+(?:log|logs|trail|chain|event|events|verify))|verification\s+report|status\s+report|hand[\s-]?off|session\s+summary|changelog|phase\s+\d+\s+report)\b/i;

/**
 * Query phrases that signal the caller WANTS history; the historical demotion
 * is skipped so "gcp exodus aar" or "what happened" still surfaces the AAR.
 */
export const HISTORY_INTENT_PATTERN =
  /\b(?:history|historical|aar|post[\s-]?mortem|what\s+happened|changelog|lessons?|retrospective|why\s+did\s+we|timeline)\b/i;

/** Minimal per-hit input for the policy. Both fields are optional (fail-open). */
export interface RerankPolicyInput {
  title?: string;
  lifecycle?: string;
}

/** Explainable breakdown of the policy multiplier for one hit. */
export interface RerankPolicyFactors {
  lifecycle: number;
  historical: number;
  /** lifecycle * historical */
  product: number;
}

/** True if the query asks for history/postmortem material. */
export function hasHistoryIntent(query: string | undefined): boolean {
  return query !== undefined && HISTORY_INTENT_PATTERN.test(query);
}

/** True if the title looks like a point-in-time record. */
export function isHistoricalRecordTitle(title: string | undefined): boolean {
  return title !== undefined && HISTORICAL_TITLE_PATTERN.test(title);
}

/** Lifecycle multiplier. Missing or unknown lifecycle = active = 1. */
export function lifecycleFactor(lifecycle: string | undefined): number {
  switch (lifecycle) {
    case 'deprecated':
      return LIFECYCLE_DEPRECATED_FACTOR;
    case 'archived':
    case 'superseded':
      return LIFECYCLE_ARCHIVED_FACTOR;
    default:
      return 1;
  }
}

/**
 * Compute the policy multiplier for one hit. The lifecycle factor always
 * applies. The historical factor applies only when a query was supplied and
 * does not signal history intent: with no query the caller gets pre-policy
 * behavior, so existing callers are unchanged.
 */
export function computeRerankPolicyFactors(
  input: RerankPolicyInput,
  query?: string,
): RerankPolicyFactors {
  const lifecycle = lifecycleFactor(input.lifecycle);
  const demoteHistorical =
    query !== undefined && !hasHistoryIntent(query) && isHistoricalRecordTitle(input.title);
  const historical = demoteHistorical ? HISTORICAL_RECORD_FACTOR : 1;
  return { lifecycle, historical, product: lifecycle * historical };
}
