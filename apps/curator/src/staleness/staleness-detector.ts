import type { CuratedMemory } from '@qmd-team-intent-kb/schema';

/**
 * Evidence-linked staleness detection (bead `compile-then-govern-39z.2`).
 *
 * The deterministic, model-free half of truth-maintenance: a memory is stale
 * when a rule in {@link ESTATE_STALENESS_RULES} declares the estate fact it
 * depends on gone, and the memory's text or provenance implicates that rule's
 * tokens — a platform that was torn
 * down, a repo that was renamed, a service that was removed. No LLM, no
 * embeddings, no similarity. Just: does the thing this answer tells you to use
 * still exist?
 *
 * ## Why this exists
 *
 * Supersession as built is a near-duplicate collapser (Jaccard over title tokens
 * within one category), so nothing has ever been retired for being WRONG — only
 * for being RESTATED. Meanwhile a live probe of `how do I deploy to production`
 * on 2026-07-31 returned 5 hits, 0 correct, 2 of them recommending `gcloud`
 * against an estate whose GCP footprint was torn down on 2026-07-09.
 *
 * Retrieval quality cannot fix that: those answers are genuinely ON TOPIC, so a
 * better ranker surfaces them HIGHER. The fix has to retire them.
 *
 * Pattern borrowed from the RCSB PDB AI Help Desk (arXiv:2604.22800), which
 * keeps a KB current by hash-detecting changes in its source documents. Ours is
 * the same shape at the estate level, and it is the cheapest signal available.
 *
 * ## The distinction that makes or breaks this
 *
 * A naive `content.includes('gcloud')` sweep deprecates the wrong rows. Two
 * kinds of memory mention a dead platform, and they are OPPOSITE:
 *
 *   PRESCRIPTIVE — "deploy with `gcloud run deploy`, store secrets in Secret
 *                  Manager"  → the answer is now WRONG. Retire it.
 *
 *   HISTORICAL   — "the GCP estate was torn down 2026-07-09; never use gcloud"
 *                  → this IS the correct answer to "why no GCP?". Retiring it
 *                    would delete the very record that justifies the retirement,
 *                    and would make the estate LESS able to explain itself.
 *
 * Dead-platform matches need an affirmative instruction in prose to become a
 * retirement candidate. Narratives, provenance-only mentions and uncertain or
 * mixed contexts remain explicit manual-review findings. Pure teardown records
 * retain their exemption. This is a small syntax heuristic, not general natural
 * language understanding or a measured corpus-precision claim.
 *
 * ## What this module does NOT do
 *
 * It does not mutate anything or authorize a transition. Both dispositions are
 * dry-run findings; a future apply path must independently verify rule authority
 * (decision/teardown receipts), govern and receipt any reversible transition.
 * The current dated rule descriptions do not satisfy that prerequisite. An empty
 * result is not a verdict that a memory is current, safe or useful.
 *
 * @module staleness/staleness-detector
 */

/**
 * A single estate fact declared dead by the rule author. The rule hygiene test
 * (every `because` carries a date) makes a retirement EXPLAINABLE — not proven:
 * the code never independently verifies the estate; it verifies the memory
 * against the rule.
 */
export interface StalenessRule {
  /** Stable id, recorded in the audit event so a retirement can be explained. */
  readonly id: string;
  /** Plain-English statement of the dead fact, including the date it died. */
  readonly because: string;
  /**
   * Tokens whose presence implicates this rule. Matched case-insensitively on
   * word-ish boundaries (see {@link mentions}) so `bq` does not fire inside
   * `bqueue` and `ntfy` does not fire inside `ntfyd`.
   */
  readonly tokens: readonly string[];
  /**
   * Whether a HISTORICAL framing exempts the memory.
   *
   * `true` for torn-down platforms: a memory recording the teardown is the
   * answer we want to keep. `false` for pure renames — "the repo is called
   * `qmd-team-intent-kb`" is wrong whether stated prescriptively or
   * historically, because the name simply no longer resolves.
   */
  readonly exemptIfHistorical: boolean;
}

/** Why one memory was flagged. */
export interface StalenessFinding {
  readonly memoryId: string;
  readonly ruleId: string;
  /** Neither disposition authorizes retirement or proves the rule's claim. */
  readonly disposition: 'retirement-candidate' | 'manual-review';
  /** Rule declaration, matched tokens and the dry-run disposition. */
  readonly evidence: string;
  /** The matched tokens, for operator review before a bulk apply. */
  readonly matched: readonly string[];
}

/**
 * The estate's dead facts, each with the date it died.
 *
 * Every entry here is a CLAIM ABOUT THE ESTATE, not about language. Adding a
 * rule means asserting "this no longer exists", so each carries its date and
 * should be traceable to a decision record or teardown.
 */
export const ESTATE_STALENESS_RULES: readonly StalenessRule[] = [
  {
    id: 'gcp-torn-down-2026-07-09',
    because:
      'The GCP estate was torn down on 2026-07-09 (0 billing-enabled projects; ' +
      'BigQuery, Vertex, Firebase and Cloud Run all gone). Any answer that tells ' +
      'you to USE these is wrong.',
    tokens: [
      'gcloud',
      'bq',
      'bigquery',
      'vertex ai',
      'vertexai',
      'firebase',
      'firestore',
      'cloud run',
      'app engine',
      'secret manager',
      'gcp project',
    ],
    exemptIfHistorical: true,
  },
  {
    id: 'repo-renamed-2026-07-19-compiler',
    because:
      'The repo `intentional-cognition-os` was renamed to `bobs-big-brain-compiler` ' +
      'on 2026-07-19. (The npm package name and the `@ico/*` scope did NOT change, ' +
      'so this rule matches the REPO/URL form only.)',
    tokens: ['jeremylongshore/intentional-cognition-os'],
    exemptIfHistorical: false,
  },
  {
    id: 'repo-renamed-2026-07-19-registrar',
    because:
      'The repo `qmd-team-intent-kb` was renamed to `bobs-big-brain-registrar` on ' +
      '2026-07-19. (The `@qmd-team-intent-kb/*` package scope and the GHCR image ' +
      'did NOT change, so this rule matches the REPO/URL form only.)',
    tokens: ['jeremylongshore/qmd-team-intent-kb'],
    exemptIfHistorical: false,
  },
  {
    id: 'repo-renamed-2026-07-14-plugin',
    because:
      'The plugin repo/dir `governed-second-brain-plugin` was renamed to ' +
      '`bobs-big-brain-plugin` on 2026-07-14.',
    tokens: ['governed-second-brain-plugin'],
    exemptIfHistorical: false,
  },
  {
    id: 'marketplace-retired-2026-07-17',
    because:
      'The private marketplace repo `team-intent-claude-plugins` was retired and ' +
      'archived on 2026-07-17. "Team" is a runtime MODE of the public plugin, not ' +
      'a separate repo.',
    tokens: ['team-intent-claude-plugins'],
    exemptIfHistorical: true,
  },
  {
    id: 'ntfy-removed-2026-06-13',
    because:
      'The ntfy container was removed on 2026-06-13 when alerting was rebuilt ' +
      'Slack-only. There is no ntfy topic to publish to.',
    tokens: ['ntfy'],
    exemptIfHistorical: true,
  },
];

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
 * @returns One finding per non-exempt matching rule. Ambiguous matches remain
 *          manual-review findings. An empty array is not a health verdict.
 */
export function detectStaleness(
  memory: Pick<CuratedMemory, 'id' | 'title' | 'content' | 'metadata'>,
  rules: readonly StalenessRule[] = ESTATE_STALENESS_RULES,
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
    const disposition = dispositionFor(rule, matched, prose, contexts);
    if (disposition === undefined) continue;

    findings.push({
      memoryId: memory.id,
      ruleId: rule.id,
      disposition,
      evidence: `${rule.because} Matched: ${matched.map((m) => `"${m}"`).join(', ')}. Dry-run disposition: ${disposition}; not transition authorization.`,
      matched,
    });
  }
  return findings;
}
