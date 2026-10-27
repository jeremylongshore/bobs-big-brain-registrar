import type { CuratedMemory } from '@qmd-team-intent-kb/schema';

import { ESTATE_STALENESS_RULES, type StalenessRule } from './staleness-rules.js';

export { ESTATE_STALENESS_RULES } from './staleness-rules.js';
export type { StalenessRule } from './staleness-rules.js';

/**
 * Deterministic dry-run triage, not truth verification or transition authority.
 * Historical records, scope assessments and proposed remedies stay separate.
 * Platform prescriptions become candidates only with a matching caller-supplied
 * estate scope assessment and pinned rule references. Neither is independently
 * authenticated here. Assessments apply only to this invocation and must be
 * reassessed after any memory edit; they are not persistent approvals.
 * Ambiguous prose remains review; clear history is exempt.
 * Renames always request metadata/link review, including working redirects.
 * Empty results do not establish currency, safety or usefulness. No I/O or apply.
 */
export interface StalenessScopeAssessment {
  readonly memoryId: string;
  readonly ruleId: string;
  readonly scope: 'intent-solutions-estate' | 'external' | 'unresolved';
  /** Caller-provided evidence locator, not fetched or authenticated here. */
  readonly evidenceRef: string;
}

export interface StalenessFinding {
  readonly memoryId: string;
  readonly ruleId: string;
  readonly disposition: 'retirement-candidate' | 'manual-review';
  readonly remedy: StalenessRule['remedy'];
  readonly authority: StalenessRule['authority'];
  /** null means applicability has not been explicitly assessed for this pair. */
  readonly scopeEvidenceRef: string | null;
  readonly evidence: string;
  readonly matched: readonly string[];
}

/**
 * Phrases that mark a mention as a RECORD of something being gone rather than
 * INSTRUCTIONS to use it.
 *
 * Deliberately generous. Each phrase here converts a would-be retirement into a
 * keep, and the asymmetry argument in the module docs says that is the safe
 * direction to err.
 */
const HISTORICAL_MARKERS: readonly string[] = [
  'torn down',
  'tore down',
  'teardown',
  'decommission',
  'exodus',
  'migrated off',
  'migrated away',
  'moved off',
  'no longer use',
  'no longer used',
  'do not use',
  "don't use",
  'never use',
  'stopped using',
  'retired',
  'deprecated',
  'archived',
  'sunset',
  'no gcp',
  'not used',
  'fully exited',
  'exited',
  'wound down',
  'shut down',
  'removed',
  'legacy',
  'historical',
  'formerly',
  'used to',
  'superseded',
  'replaced by',
  'renamed to',
];

/**
 * Case-insensitive token match on word-ish boundaries.
 *
 * Uses `indexOf` plus an explicit boundary check rather than a built `RegExp`:
 * rule tokens contain regex metacharacters in practice (`.`, `/`, `-`) and would
 * otherwise need escaping, and a scan has no backtracking behaviour to reason
 * about on long memory bodies. A boundary is "not a letter or digit", which lets
 * `cloud run` match inside a sentence while keeping `bq` from firing inside
 * `bqueue` or `sbq`.
 */
export function mentions(haystack: string, token: string): boolean {
  const hay = haystack.toLowerCase();
  const needle = token.toLowerCase();
  if (needle === '') return false;

  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return false;

    const before = at === 0 ? '' : hay[at - 1]!;
    const afterIdx = at + needle.length;
    const after = afterIdx >= hay.length ? '' : hay[afterIdx]!;
    if (!isWordChar(before) && !isWordChar(after)) return true;

    from = at + 1;
  }
}

function isWordChar(ch: string): boolean {
  if (ch === '') return false;
  return /[a-z0-9]/.test(ch);
}

/**
 * Does this text read as a RECORD that something is gone, rather than
 * instructions to use it?
 *
 * @see HISTORICAL_MARKERS for the (deliberately generous) marker list.
 */
export function readsAsHistorical(text: string): boolean {
  const lower = text.toLowerCase();
  return HISTORICAL_MARKERS.some((marker) => lower.includes(marker));
}

interface ProseContext {
  readonly text: string;
  readonly opaque: boolean;
}

/** Keep code/quotes visible as matches, but never interpret them as instructions. */
function proseContexts(prose: string): ProseContext[] {
  const contexts: ProseContext[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of prose.split(/\r?\n/)) {
    const fenceLine = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = fenceLine?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0]!, length: marker.length };
      else if (
        marker[0] === fence.char &&
        marker.length >= fence.length &&
        fenceLine![2]!.trim() === ''
      )
        fence = undefined;
      contexts.push({ text: line, opaque: true });
      continue;
    }
    const opaque = fence !== undefined || /^\s*>|^(?: {4}|\t)/.test(line);
    for (const text of line.split(/(?<=[.!?;])\s+/)) {
      if (text.trim()) contexts.push({ text, opaque });
    }
  }
  return contexts;
}

const INSTRUCTION =
  /^(?:(?:[-*+]|\d+[.)])\s+)?(?:please\s+)?(?:use|run|deploy|publish|install|configure|create|store|enable|connect|send|subscribe|set up)\b/i;
const MODAL_INSTRUCTION =
  /\b(?:should|must|needs? to|recommend(?:s)?(?: that (?:we|you))?)\s+(?:use|run|deploy|publish|install|configure|create|store|enable|connect|send|subscribe|set up)\b/i;
const UNCERTAIN_CONTEXT =
  /\?|\b(?:if|unless|whether|could|might|may|would|perhaps|maybe|suppose|example|quoted|but|however|instead|although|rather)\b/i;
const PAST_NARRATIVE = /\b(?:previously|yesterday|was|were|had|built|involved)\b/i;
const NEGATIVE_CONTEXT = /\b(?:not|never|avoid|without|don't|no|nobody|none|nothing|neither)\b/i;
// Be conservative even when sentence splitting crosses a quoted span. A plain
// apostrophe inside a word (Hustle's) is not a quotation delimiter.
const QUOTED_CONTEXT = /["“”‘’]|(?:^|\s)'|'(?:\s|[.!?;]|$)/;

function affirmativeInstruction(context: ProseContext, tokens: readonly string[]): boolean {
  if (
    context.opaque ||
    QUOTED_CONTEXT.test(context.text) ||
    UNCERTAIN_CONTEXT.test(context.text) ||
    PAST_NARRATIVE.test(context.text)
  ) {
    return false;
  }
  // Inline code remains meaningful in "Run `gcloud ...`". Quoted prose does not:
  // "The old instruction was 'Use Firestore'" must not become a candidate.
  const unquoted = context.text.replace(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’/g, ' ').trim();
  if (!tokens.some((token) => mentions(unquoted, token))) return false;
  if (readsAsHistorical(unquoted) || NEGATIVE_CONTEXT.test(unquoted)) return false;
  return INSTRUCTION.test(unquoted) || MODAL_INSTRUCTION.test(unquoted);
}

/** Conservative triage only; no returned value authorizes an apply. */
function dispositionFor(
  rule: StalenessRule,
  matched: readonly string[],
  prose: string,
  contexts: readonly ProseContext[],
): StalenessFinding['disposition'] | undefined {
  if (rule.remedy === 'metadata-review') return 'manual-review';
  if (!rule.exemptIfHistorical) return 'retirement-candidate';
  // A historical token cannot explain a different token found only in a path.
  if (matched.some((token) => !mentions(prose, token))) return 'manual-review';
  // Quoted prose can span sentences/lines; Markdown also permits blockquote
  // continuation lines without `>`. Without a full parser, keep any such
  // document in review rather than infer where its quotation ends.
  if (QUOTED_CONTEXT.test(prose) || /^\s*>/m.test(prose)) return 'manual-review';
  const relevant = contexts.filter((context) =>
    rule.tokens.some((token) => mentions(context.text, token)),
  );
  const affirmative = relevant.filter((context) => affirmativeInstruction(context, rule.tokens));
  const pureHistory =
    relevant.length > 0 &&
    relevant.every(
      (context) =>
        !context.opaque &&
        !QUOTED_CONTEXT.test(context.text) &&
        !UNCERTAIN_CONTEXT.test(context.text) &&
        readsAsHistorical(context.text),
    );
  if (pureHistory && affirmative.length === 0) return undefined;
  if (affirmative.length === relevant.length && relevant.length > 0 && !readsAsHistorical(prose)) {
    return 'retirement-candidate';
  }
  return 'manual-review';
}

/**
 * Detect estate-fact staleness in one memory.
 *
 * Scans title + content + the metadata provenance fields (`filePaths`,
 * `repoUrl`, `projectContext`), because a memory can implicate a renamed repo
 * purely through its provenance while its prose never names it.
 *
 * @param memory - The curated memory to inspect. Lifecycle is NOT checked here;
 *                 the caller decides which lifecycle states are in scope (a
 *                 sweep normally passes only `active` ones).
 * @param rules  - Rule set to apply. Defaults to {@link ESTATE_STALENESS_RULES};
 *                 injectable so tests do not depend on the live estate.
 * @param scopeAssessments - Caller assessments bound to memory AND rule, never
 * inferred from tags, paths or repository identity. These are review inputs, not
 * verified authority. Without one, prescriptions remain manual review.
 * @returns One finding per non-exempt matching rule. Ambiguous matches remain
 *          manual-review findings. An empty array is not a health verdict.
 */
export function detectStaleness(
  memory: Pick<CuratedMemory, 'id' | 'title' | 'content' | 'metadata'>,
  rules: readonly StalenessRule[] = ESTATE_STALENESS_RULES,
  scopeAssessments: readonly StalenessScopeAssessment[] = [],
): StalenessFinding[] {
  const provenance = [
    ...(memory.metadata?.filePaths ?? []),
    memory.metadata?.repoUrl ?? '',
    memory.metadata?.projectContext ?? '',
  ].join(' ');

  const haystack = `${memory.title}\n${memory.content}\n${provenance}`;
  // Historical framing is judged on the PROSE only. Provenance paths are inert
  // strings — a file path cannot narrate that a platform was torn down, and
  // letting it vote would misclassify on an incidental path component.
  const prose = `${memory.title}\n${memory.content}`;
  const contexts = proseContexts(prose);

  const findings: StalenessFinding[] = [];
  for (const rule of rules) {
    const matched = rule.tokens.filter((t) => mentions(haystack, t));
    if (matched.length === 0) continue;
    const proposedDisposition = dispositionFor(rule, matched, prose, contexts);
    if (proposedDisposition === undefined) continue;
    const assessments = scopeAssessments.filter(
      (item) => item.memoryId === memory.id && item.ruleId === rule.id,
    );
    // Duplicate/conflicting assessments require reconciliation, never first-wins.
    const soleAssessment = assessments.length === 1 ? assessments[0] : undefined;
    const assessment =
      soleAssessment?.scope === rule.authority?.scope && soleAssessment?.evidenceRef.trim() !== ''
        ? soleAssessment
        : undefined;
    const pinnedSources =
      rule.authority != null &&
      rule.authority.sources.length > 0 &&
      rule.authority.sources.every(
        (source) =>
          /^[a-f0-9]{40}$/.test(source.revision) &&
          /^[a-f0-9]{64}$/.test(source.sha256) &&
          source.repository.trim() !== '' &&
          source.path.trim() !== '' &&
          source.locator.trim() !== '',
      );
    const disposition =
      proposedDisposition === 'retirement-candidate' && (!assessment || !pinnedSources)
        ? 'manual-review'
        : proposedDisposition;

    findings.push({
      memoryId: memory.id,
      ruleId: rule.id,
      disposition,
      remedy: rule.remedy,
      authority: rule.authority,
      scopeEvidenceRef: assessment?.evidenceRef ?? null,
      evidence: `${rule.because} Matched: ${matched.map((m) => `"${m}"`).join(', ')}. Remedy: ${rule.remedy}. Scope: ${assessment?.evidenceRef ?? 'unassessed'}. Rule evidence: ${rule.authority?.limitations ?? 'not supplied'}. Dry-run disposition: ${disposition}; not transition authorization.`,
      matched,
    });
  }
  return findings;
}
