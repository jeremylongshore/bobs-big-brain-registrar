/**
 * Disclosure content filter for candidate intake (bead `3iu.1`).
 *
 * Ports the HARD-FAIL patterns from `intent-os/ci/disclosure-gate.sh` into a
 * server-side check so the no-compensation / no-PII disclosure rule is enforced
 * at the boundary instead of by honor system. A candidate whose free text
 * matches a hard-fail pattern is rejected (HTTP 422) before it can enter the
 * inbox or the governed brain.
 *
 * Scope — deliberately narrow, matching the gate:
 *   - **Compensation / equity / comp-split** terms (pay, equity, vesting, splits).
 *   - **PII** (SSN, background-check results, date of birth).
 * Client / revenue money (pricing menus, deal values) is ALLOWED and is NOT
 * flagged — only the gate's hard-fail patterns are ported; its advisory /
 * contextual word list is intentionally excluded to avoid false positives.
 *
 * Domain adaptation (vs. a literal port): this brain stores *technical* Claude
 * Code memories, where a bare numeric ratio like `70/30 split` overwhelmingly
 * means a traffic / data / canary split, not compensation. So the bare
 * ratio-split pattern fires only alongside a money/comp keyword
 * ({@link COMP_CONTEXT_PATTERN}); the unambiguous comp terms always fire. The
 * matched substring is never returned — echoing a flagged value (especially
 * PII) would re-leak it into logs and responses.
 *
 * @module services/disclosure-filter
 */

export type DisclosureCategory = 'compensation' | 'pii';

export interface DisclosureViolation {
  /** Which disclosure rule the text violated. */
  category: DisclosureCategory;
}

/**
 * Unambiguous personal-compensation / equity terms — these never describe
 * legitimate technical content, so they hard-fail on their own. Ported from
 * `disclosure-gate.sh` §1, with `\b` boundaries on `vesting` so it does not
 * match `investing` / `harvesting`.
 */
export const COMPENSATION_TERMS_PATTERN =
  /\bsalary\b|base pay\b|take[- ]home pay\b|(?:launch|signing|sign[- ]on) bonus|equity\s+(?:stakes?|grants?|granted|options?)\b|equity\s+[0-9]|\bvesting\b|\bRSUs?\b|stock options?\b|revenue[- ]share\s*[0-9]|7[- ]bucket/i;

/**
 * A numeric ratio expressed as a `split` / `share` (e.g. `60/40 split`, or the
 * `60/40 -> 50/50` migration notation from the 7-bucket work). On its own this
 * is ambiguous in a technical corpus, so it only counts as a violation when
 * {@link COMP_CONTEXT_PATTERN} also matches. Ported from `disclosure-gate.sh` §1.
 */
export const RATIO_SPLIT_PATTERN =
  /[0-9]{1,3}\s*\/\s*[0-9]{1,3}\s*(?:split|share)|[0-9]{1,2}\s*\/\s*[0-9]{1,2}\s*(?:max|→|->)\s*[0-9]{1,2}\s*\/\s*[0-9]{1,2}/i;

/** Money / compensation context that promotes a bare ratio-split to a violation. */
export const COMP_CONTEXT_PATTERN =
  /\b(?:compensation|comp|revenue|profit|equity|payout|royalty|salary|wage|bonus|earnings)\b|take[- ]home/i;

/**
 * Hard-fail PII patterns — SSNs and background-check data, which never belong in
 * this repo or the brain. Ported from `disclosure-gate.sh` §2.
 */
export const PII_PATTERN =
  /[0-9]{3}-[0-9]{2}-[0-9]{4}|\bSSN\b|social security (?:number|no)|background[- ]check (?:result|report|passed|failed)|date of birth|\bDOB\b\s*[:=]/i;

/**
 * Scan a single string for a hard-fail disclosure violation.
 * Returns the violated category, or `null` when the text is clean.
 *
 * PII is checked first (most sensitive), then unambiguous compensation terms,
 * then the context-gated numeric ratio-split.
 */
export function scanDisclosure(text: string): DisclosureViolation | null {
  if (PII_PATTERN.test(text)) return { category: 'pii' };
  if (COMPENSATION_TERMS_PATTERN.test(text)) return { category: 'compensation' };
  if (RATIO_SPLIT_PATTERN.test(text) && COMP_CONTEXT_PATTERN.test(text)) {
    return { category: 'compensation' };
  }
  return null;
}

/**
 * Scan every supplied free-text field, returning the first violation found
 * (or `null` when all fields are clean).
 */
export function scanDisclosureFields(fields: readonly string[]): DisclosureViolation | null {
  for (const field of fields) {
    const violation = scanDisclosure(field);
    if (violation !== null) return violation;
  }
  return null;
}
