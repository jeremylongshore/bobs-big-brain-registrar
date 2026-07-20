/**
 * groundedness scorer v1 — DETERMINISTIC support-by-admitted-facts check
 * (Wave-2 C2). Pure function, zero I/O, zero model calls; safe for CI by
 * construction (the platform's rule: no LLM in any gating path).
 *
 * ## How it decides
 *
 * A claim is predicted `supported` by a memory excerpt iff ALL of:
 *   1. NUMBERS — every quantity in the claim (digits, `5/5` ratios, dotted
 *      versions, and the spelled numbers two…twelve; "one" is excluded as too
 *      ambiguous a word) also appears in the memory. An inverted/absent
 *      number is the strongest unsupported signal.
 *   2. NEGATION POLARITY — no term is negated in one text but asserted
 *      plainly in the other. Markers: not/never/no/without/avoid/…; scope =
 *      the next {@link NEGATION_WINDOW} content token(s) WITHIN the same
 *      clause (clauses split on punctuation, so "no results, it falls back"
 *      does not leak the negation onto "falls back"). "Plainly asserted"
 *      means: appears in a clause carrying NO negation marker; terms the
 *      same text uses in both polarities are treated as unreliable and
 *      skipped. An affix-antonym check (sufficient ↔ insufficient via
 *      in-/un-/non- prefixes) covers flips that change the token itself.
 *   3. TOKEN SUPPORT — at least `tokenSupportThreshold` of the claim's
 *      distinct content tokens (stopwords and numbers excluded) are present
 *      in the memory under light suffix-variant matching
 *      (s/es/ed/ing, e.g. "importing" ↔ "import", "shared" ↔ "share").
 *      Wrong-component claims introduce vocabulary the memory never admitted
 *      and fall below the floor.
 *
 * ## Limits — stated honestly, measured in the fixture
 *
 * This attests support-by-admitted-facts, NOT truth and NOT entailment:
 *   - An ARGUMENT SWAP ("local uses X, remote uses Y" → "local uses Y,
 *     remote uses X") preserves tokens, numbers, and polarity — v1 cannot
 *     see it. The fixture carries such items as documented scorer misses.
 *   - Negation matching is variant-token-exact, so a flip whose vocabulary
 *     fully drifts from the negated head can escape the polarity check and
 *     is only caught if its token support also drops.
 *   - A supported paraphrase that is TOO free (mostly novel vocabulary) can
 *     fall below the token floor — a false "unsupported".
 * The thresholds and window sizes were tuned on the v1 fixture itself
 * (in-sample); treat the reported metrics accordingly. An env-gated LLM judge
 * exists as an OFFLINE COMPARISON ARM ONLY (see ./llm-judge.ts) — it never
 * runs in CI and never gates.
 */

import type { GroundednessPrediction } from './types.js';

/** Default minimum fraction of claim content tokens the memory must admit. */
export const DEFAULT_TOKEN_SUPPORT_THRESHOLD = 0.7;

const NEGATION_MARKERS = new Set([
  'not',
  'never',
  'no',
  'none',
  'cannot',
  'cant',
  'dont',
  'doesnt',
  'isnt',
  'arent',
  'wont',
  'without',
  'non',
  'neither',
  'nor',
  'avoid',
  'avoids',
  'avoided',
  'avoiding',
]);

/**
 * Content tokens after a negation marker (same clause) inside its scope.
 * Deliberately 1 — the immediate negated head. Wider windows drag object /
 * prepositional tokens into the scope and mis-fire on paraphrases (measured
 * on fixture v1: window 4 falsely flagged 14 supported paraphrases).
 */
const NEGATION_WINDOW = 1;

/** Prefixes that flip a term's polarity in place (sufficient → insufficient). */
const ANTONYM_PREFIXES = ['in', 'un', 'non'] as const;

/** Minimum base-token length for the affix-antonym check (avoids side↔inside noise). */
const ANTONYM_MIN_BASE = 4;

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'than',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'for',
  'from',
  'with',
  'as',
  'into',
  'about',
  'between',
  'through',
  'so',
  'such',
  'can',
  'could',
  'should',
  'would',
  'may',
  'might',
  'must',
  'will',
  'shall',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
  'he',
  'she',
  'they',
  'we',
  'you',
  'i',
  'their',
  'his',
  'her',
  'our',
  'your',
  'each',
  'every',
  'all',
  'any',
  'some',
  'both',
  'more',
  'most',
  'other',
  'own',
  'same',
  'which',
  'what',
  'when',
  'where',
  'while',
  'who',
  'whom',
  'how',
  'why',
  'also',
  'only',
  'very',
  'via',
  'per',
  'up',
  'out',
  'over',
  'under',
  's',
  't',
]);

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
};

/** Raw lowercase word tokens (letters+digits runs). */
function rawTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Clause strings — negation scope never crosses these boundaries. */
function clauses(text: string): string[] {
  return text.split(/[.,;:()!?…]|—|–|\s-\s|\n/).filter((c) => c.trim().length > 0);
}

/**
 * Light suffix-variant forms of a token (s/es/ed/ing with an `e`-restore for
 * ed/ing), so "importing"→"import", "shared"→"share", "packages"→"package".
 */
function variantsOf(token: string): string[] {
  const out = new Set([token]);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    out.add(token.slice(0, -1));
  }
  if (token.length > 4 && token.endsWith('es')) out.add(token.slice(0, -2));
  if (token.length > 4 && token.endsWith('ed')) {
    out.add(token.slice(0, -2));
    out.add(`${token.slice(0, -2)}e`);
  }
  if (token.length > 5 && token.endsWith('ing')) {
    out.add(token.slice(0, -3));
    out.add(`${token.slice(0, -3)}e`);
  }
  return [...out];
}

function isContentToken(t: string): boolean {
  return !STOPWORDS.has(t) && !/^\d+$/.test(t) && !(t in NUMBER_WORDS) && !NEGATION_MARKERS.has(t);
}

/** All variant forms of every content token in a text. */
function variantSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of rawTokens(text)) {
    if (!isContentToken(t)) continue;
    for (const v of variantsOf(t)) out.add(v);
  }
  return out;
}

/** Does `token` (any of its variant forms) appear in a variant set? */
function inVariantSet(token: string, set: ReadonlySet<string>): boolean {
  return variantsOf(token).some((v) => set.has(v));
}

/**
 * Quantities in a text: digit runs incl. `5/5` ratios and dotted versions
 * (`1.2.3` contributes itself plus its segments), and spelled two…twelve.
 */
export function extractNumbers(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.match(/\d+(?:[./]\d+)*[a-z]?/g) ?? []) {
    out.add(m);
    for (const part of m.split(/[./]/)) out.add(part);
  }
  for (const t of rawTokens(lower)) {
    const mapped = NUMBER_WORDS[t];
    if (mapped !== undefined) out.add(mapped);
  }
  return out;
}

/** Content terms inside the (clause-bounded) scope of a negation marker. */
export function negatedTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const clause of clauses(text)) {
    const tokens = rawTokens(clause);
    for (let i = 0; i < tokens.length; i++) {
      if (!NEGATION_MARKERS.has(tokens[i]!)) continue;
      let collected = 0;
      for (let j = i + 1; j < tokens.length && collected < NEGATION_WINDOW; j++) {
        const t = tokens[j]!;
        if (!isContentToken(t)) continue;
        out.add(t);
        collected++;
      }
    }
  }
  return out;
}

/**
 * Terms PLAINLY asserted by a text: content tokens of clauses that carry no
 * negation marker at all. Deliberately conservative — a term that only ever
 * appears near a negation is not "plainly asserted".
 */
function plainTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const clause of clauses(text)) {
    const tokens = rawTokens(clause);
    if (tokens.some((t) => NEGATION_MARKERS.has(t))) continue;
    for (const t of tokens) {
      if (isContentToken(t)) out.add(t);
    }
  }
  return out;
}

/**
 * Affix-antonym mismatches: a term one text asserts whose in-/un-/non-
 * prefixed form the other text carries (sufficient ↔ insufficient). Skipped
 * when either text carries BOTH forms (unreliable).
 */
function affixMismatches(
  claimTokens: ReadonlySet<string>,
  memoryTokens: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const flipped = (base: string, from: ReadonlySet<string>): boolean =>
    ANTONYM_PREFIXES.some((p) => from.has(`${p}${base}`));
  for (const t of claimTokens) {
    if (t.length < ANTONYM_MIN_BASE) continue;
    // claim asserts `t`, memory only carries its prefixed antonym (or vice versa)
    if (flipped(t, memoryTokens) && !memoryTokens.has(t) && !flipped(t, claimTokens)) {
      out.push(t);
    }
  }
  for (const t of memoryTokens) {
    if (t.length < ANTONYM_MIN_BASE) continue;
    if (flipped(t, claimTokens) && !claimTokens.has(t) && !flipped(t, memoryTokens)) {
      out.push(t);
    }
  }
  return out;
}

export interface ScoreOptions {
  /** Override the token-support floor (default {@link DEFAULT_TOKEN_SUPPORT_THRESHOLD}). */
  readonly tokenSupportThreshold?: number;
}

/** Score one (claim, memoryExcerpt) pair. Deterministic and pure. */
export function scoreGroundedness(
  claim: string,
  memoryExcerpt: string,
  options: ScoreOptions = {},
): GroundednessPrediction {
  const threshold = options.tokenSupportThreshold ?? DEFAULT_TOKEN_SUPPORT_THRESHOLD;

  // 1. Numbers: every claim quantity must be admitted by the memory.
  const memoryNumbers = extractNumbers(memoryExcerpt);
  const numberMismatches = [...extractNumbers(claim)].filter((n) => !memoryNumbers.has(n));

  // 2. Negation polarity, both directions (variant-matched, clause-bounded,
  //    mixed-polarity terms skipped as unreliable).
  const memoryVariants = variantSet(memoryExcerpt);
  const memNeg = negatedTerms(memoryExcerpt);
  const claimNeg = negatedTerms(claim);
  const memNegVariants = new Set([...memNeg].flatMap(variantsOf));
  const claimNegVariants = new Set([...claimNeg].flatMap(variantsOf));
  const memPlain = new Set([...plainTerms(memoryExcerpt)].flatMap(variantsOf));
  const claimPlain = new Set([...plainTerms(claim)].flatMap(variantsOf));
  const negationMismatches = [
    // claim plainly asserts a term the memory negates (and never plainly uses)
    ...[...memNeg].filter(
      (t) =>
        !inVariantSet(t, memPlain) && // memory's own polarity must be unmixed
        inVariantSet(t, claimPlain) &&
        !inVariantSet(t, claimNegVariants),
    ),
    // claim negates a term the memory plainly asserts (and never negates)
    ...[...claimNeg].filter(
      (t) =>
        !inVariantSet(t, claimPlain) && // claim's own polarity must be unmixed
        inVariantSet(t, memPlain) &&
        !inVariantSet(t, memNegVariants),
    ),
    // affix antonyms: sufficient ↔ insufficient shaped flips
    ...affixMismatches(
      new Set(rawTokens(claim).filter(isContentToken)),
      new Set(rawTokens(memoryExcerpt).filter(isContentToken)),
    ),
  ];

  // 3. Token support: fraction of DISTINCT claim content tokens the memory admits.
  const distinct = [...new Set(rawTokens(claim).filter(isContentToken))];
  const admitted = distinct.filter((t) => inVariantSet(t, memoryVariants)).length;
  const tokenSupport = distinct.length === 0 ? 1 : admitted / distinct.length;

  const predicted =
    numberMismatches.length === 0 && negationMismatches.length === 0 && tokenSupport >= threshold
      ? 'supported'
      : 'unsupported';

  return {
    predicted,
    tokenSupport: Number(tokenSupport.toFixed(4)),
    numberMismatches,
    negationMismatches,
  };
}
