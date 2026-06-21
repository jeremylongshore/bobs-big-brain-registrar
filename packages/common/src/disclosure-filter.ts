/**
 * Disclosure + secret content filter — the single PII / comp-secret / secret-leak
 * choke point for the governed brain (Epic 0, compile-then-govern-c5k).
 *
 * This module lives in `@qmd-team-intent-kb/common` (zero runtime deps) on
 * purpose: it is enforced inside `CandidateRepository.insert()` — the one SQL
 * INSERT every candidate write path crosses (API intake, curator bulk-import,
 * spool-intake / ICO ingest, MCP propose→spool, promotion re-scan). Putting the
 * filter in `common` keeps the dependency direction clean (store already depends
 * on common) so no path can be added later that bypasses the gate.
 *
 * ## Threat model this closes
 *
 *   - **PII** (SSN, background-check results, DOB) and **compensation / equity /
 *     comp-split** secrets must never enter the inbox or the governed brain.
 *   - **Credentials / API keys** (gitleaks-class) leaking into stored memories.
 *
 * ## Hardening guarantees (Epic 0 requirements)
 *
 *   1. **Normalize before scanning.** Input is NFKC-normalized, zero-width and
 *      bidi control characters are stripped, a confusable→ASCII homoglyph fold is
 *      applied, and percent-encoding is decoded **once** — so an attacker cannot
 *      smuggle `ѕalary` (Cyrillic es), `sal​ary`, or `%73alary` past a naive
 *      ASCII regex.
 *   2. **ReDoS-safe.** Every pattern is linear-time: no nested quantifiers, no
 *      overlapping alternations under a quantifier, bounded `{n,m}` repetition.
 *      Verified by the worst-case-input timing test in `disclosure-filter.test.ts`.
 *   3. **Fail-closed.** If normalization or scanning throws for any reason, the
 *      scan reports a violation rather than silently passing — a write that cannot
 *      be proven clean is rejected. See {@link scanForDisclosure}.
 *   4. **Never log / return the matched value.** Only the violated *category* is
 *      returned. Echoing a flagged value would re-leak the secret into logs,
 *      responses, and the audit trail.
 *
 * @module disclosure-filter
 */

/** Which class of disallowed content the text violated. */
export type DisclosureCategory = 'compensation' | 'pii' | 'secret';

/**
 * A disclosure violation. Carries **only** the category — never the matched
 * substring, so the flagged value is never re-leaked into logs or responses.
 */
export interface DisclosureViolation {
  category: DisclosureCategory;
}

/* -------------------------------------------------------------------------- */
/* Pattern definitions — all ReDoS-safe (linear time, no nested quantifiers).  */
/* -------------------------------------------------------------------------- */

/**
 * Unambiguous personal-compensation / equity terms — these never describe
 * legitimate technical content, so they hard-fail on their own. `\b` boundaries
 * on `vesting` so it does not match `investing` / `harvesting`.
 */
export const COMPENSATION_TERMS_PATTERN =
  /\bsalary\b|base pay\b|take[- ]home pay\b|(?:launch|signing|sign[- ]on) bonus|equity\s+(?:stakes?|grants?|granted|options?)\b|equity\s+[0-9]|\bvesting\b|\bRSUs?\b|stock options?\b|revenue[- ]share\s*[0-9]|7[- ]bucket/i;

/**
 * A numeric ratio expressed as a `split` / `share` (e.g. `60/40 split`). On its
 * own this is ambiguous in a technical corpus, so it only counts as a violation
 * when {@link COMP_CONTEXT_PATTERN} also matches. Bounded `{1,3}` repetition.
 */
export const RATIO_SPLIT_PATTERN =
  /[0-9]{1,3}\s*\/\s*[0-9]{1,3}\s*(?:split|share)|[0-9]{1,2}\s*\/\s*[0-9]{1,2}\s*(?:max|→|->)\s*[0-9]{1,2}\s*\/\s*[0-9]{1,2}/i;

/** Money / compensation context that promotes a bare ratio-split to a violation. */
export const COMP_CONTEXT_PATTERN =
  /\b(?:compensation|comp|revenue|profit|equity|payout|royalty|salary|wage|bonus|earnings)\b|take[- ]home/i;

/**
 * Hard-fail PII patterns — SSNs and background-check data, which never belong in
 * this repo or the brain. Bounded character-class repetition only.
 */
export const PII_PATTERN =
  /[0-9]{3}-[0-9]{2}-[0-9]{4}|\bSSN\b|social security (?:number|no)|background[- ]check (?:result|report|passed|failed)|date of birth|\bDOB\b\s*[:=]/i;

/**
 * Gitleaks-class secret-detection rules. A focused, high-signal subset of the
 * gitleaks default ruleset — provider tokens with distinctive, non-overlapping
 * prefixes plus generic private-key headers. Each pattern is anchored to a fixed
 * literal prefix and uses a single bounded character class, so all are linear
 * time (no ReDoS surface). The list is intentionally conservative (low false
 * positive rate) because this gate is fail-closed on the write path.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  // AWS access key id
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  // GitHub tokens (PAT classic/fine-grained, OAuth, app, refresh)
  /\bgh[pousr]_[0-9A-Za-z]{36,255}\b/,
  // GitLab personal access token
  /\bglpat-[0-9A-Za-z_-]{20,22}\b/,
  // Slack token
  /\bxox[baprs]-[0-9A-Za-z-]{10,72}\b/,
  // Stripe secret/restricted key
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,99}\b/,
  // Google API key
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // OpenAI / Anthropic style provider keys
  /\bsk-(?:ant-)?[0-9A-Za-z_-]{20,200}\b/,
  // npm token
  /\bnpm_[0-9A-Za-z]{36}\b/,
  // SendGrid
  /\bSG\.[0-9A-Za-z_-]{16,32}\.[0-9A-Za-z_-]{16,64}\b/,
  // JWT (header.payload.signature, base64url segments)
  /\beyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/,
  // PEM private-key block headers (RSA/EC/OPENSSH/PGP/generic)
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
];

/* -------------------------------------------------------------------------- */
/* Normalization — runs BEFORE any pattern match.                              */
/* -------------------------------------------------------------------------- */

/**
 * Zero-width, bidi, and other invisible format characters used to break up a
 * keyword so it slips past an ASCII regex (e.g. a zero-width space inside
 * `salary`). Stripped before scanning. Built from explicit code-point escapes
 * (not raw glyphs) so the source stays lexer-safe and reviewable. Bounded
 * global character class — linear time.
 */
const INVISIBLE_CHARS = new RegExp(
  '[' +
    [
      0x00ad, // soft hyphen
      0x061c, // Arabic letter mark
      0x180e, // Mongolian vowel separator
      0x200b, // zero-width space
      0x200c, // zero-width non-joiner
      0x200d, // zero-width joiner
      0x200e, // left-to-right mark
      0x200f, // right-to-left mark
      0x202a, // LTR embedding
      0x202b, // RTL embedding
      0x202c, // pop directional formatting
      0x202d, // LTR override
      0x202e, // RTL override
      0x2060, // word joiner
      0x2061, // function application
      0x2062, // invisible times
      0x2063, // invisible separator
      0x2064, // invisible plus
      0x2066, // LTR isolate
      0x2067, // RTL isolate
      0x2068, // first strong isolate
      0x2069, // pop directional isolate
      0xfeff, // BOM / zero-width no-break space
    ]
      .map((cp) => String.fromCodePoint(cp))
      .join('') +
    ']',
  'g',
);

/**
 * Minimal confusable→ASCII homoglyph fold for the Latin letters that appear in
 * the keyword surface above (covers the common Cyrillic / Greek / fullwidth
 * look-alikes). This is a security fold, not a full Unicode confusables table —
 * it only needs to defeat homoglyph evasion of the keywords this filter scans
 * for, after NFKC has already collapsed compatibility forms.
 */
const HOMOGLYPH_MAP: ReadonlyMap<string, string> = new Map([
  // Cyrillic look-alikes
  ['а', 'a'],
  ['е', 'e'],
  ['о', 'o'],
  ['р', 'p'],
  ['с', 'c'],
  ['у', 'y'],
  ['х', 'x'],
  ['ѕ', 's'],
  ['і', 'i'],
  ['ј', 'j'],
  ['ԁ', 'd'],
  ['М', 'M'],
  ['Ѕ', 'S'],
  ['І', 'I'],
  ['Ј', 'J'],
  ['Ԁ', 'D'],
  ['Т', 'T'],
  ['В', 'B'],
  ['Н', 'H'],
  ['А', 'A'],
  ['Е', 'E'],
  ['О', 'O'],
  ['Р', 'P'],
  ['С', 'C'],
  ['У', 'Y'],
  ['Х', 'X'],
  // Greek look-alikes
  ['ο', 'o'],
  ['ν', 'v'],
  ['α', 'a'],
  ['ρ', 'p'],
  ['Ι', 'I'],
  ['Β', 'B'],
  ['Α', 'A'],
  ['Ε', 'E'],
  ['Ο', 'O'],
  ['Ρ', 'P'],
  ['Υ', 'Y'],
  ['Χ', 'X'],
]);

/** Apply the homoglyph fold character-by-character. Linear in input length. */
function foldHomoglyphs(text: string): string {
  let out = '';
  for (const ch of text) {
    out += HOMOGLYPH_MAP.get(ch) ?? ch;
  }
  return out;
}

/**
 * Decode percent-encoding **once** (not in a loop — repeated decoding is itself
 * an attack surface and changes legitimate content). Tolerant of malformed
 * sequences: if `decodeURIComponent` throws on a bad `%`, the original text is
 * kept (and still scanned in its raw form).
 */
function decodeOnce(text: string): string {
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Normalize text for scanning: decode-once → NFKC → strip invisibles → homoglyph
 * fold. This is the canonicalization the patterns are written against. Exported
 * for testing.
 *
 * @throws never for normal input; any internal failure is caught by the
 *   fail-closed wrapper in {@link scanForDisclosure}.
 */
export function normalizeForScan(text: string): string {
  const decoded = decodeOnce(text);
  const nfkc = decoded.normalize('NFKC');
  const stripped = nfkc.replace(INVISIBLE_CHARS, '');
  return foldHomoglyphs(stripped);
}

/* -------------------------------------------------------------------------- */
/* Scanning.                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Scan a single already-normalized string against the pattern set. Order:
 * secrets first (most damaging if leaked), then PII, then unambiguous comp,
 * then the context-gated ratio-split.
 */
function scanNormalized(text: string): DisclosureViolation | null {
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(text)) return { category: 'secret' };
  }
  if (PII_PATTERN.test(text)) return { category: 'pii' };
  if (COMPENSATION_TERMS_PATTERN.test(text)) return { category: 'compensation' };
  if (RATIO_SPLIT_PATTERN.test(text) && COMP_CONTEXT_PATTERN.test(text)) {
    return { category: 'compensation' };
  }
  return null;
}

/**
 * Scan one string for a disclosure / secret violation. Normalizes first, then
 * matches. Returns the violated category, or `null` when clean.
 *
 * **Fail-closed:** if normalization or matching throws for any reason, this
 * returns a `secret` violation rather than `null` — a string that cannot be
 * proven clean is treated as dirty. The matched value is never returned.
 */
export function scanForDisclosure(text: string): DisclosureViolation | null {
  try {
    return scanNormalized(normalizeForScan(text));
  } catch {
    // Fail-closed: an un-scannable string is rejected, never silently passed.
    return { category: 'secret' };
  }
}

/**
 * Scan every supplied field, returning the first violation found (or `null`
 * when all fields are clean). Fail-closed per {@link scanForDisclosure}.
 */
export function scanDisclosureFields(fields: readonly string[]): DisclosureViolation | null {
  for (const field of fields) {
    const violation = scanForDisclosure(field);
    if (violation !== null) return violation;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Candidate-shaped enforcement (the choke-point entry point).                 */
/* -------------------------------------------------------------------------- */

/**
 * Minimal shape of a candidate needed to scan it — the free-text surfaces that
 * can carry PII / comp / secret material. Kept structural (not a schema import)
 * so `common` stays dependency-free and the store layer can call it.
 *
 * NOTE: this interface is documentation of the *expected* shape only. The scan
 * does NOT read a hand-maintained field list off it — {@link assertDisclosureClean}
 * derives the scanned set by structurally walking the object (see
 * {@link collectFreeTextFields}), so any free-text field present on the persisted
 * candidate is scanned automatically, whether or not it is named here. The
 * hand-maintained subset was the c5k.1 leak: `tenant_id` was persisted but never
 * enumerated, so it bypassed the gate.
 */
export interface DisclosureScanInput {
  content: string;
  title: string;
  /** Tenant boundary id. Persisted to the `tenant_id` column; free-text, so scanned. */
  tenantId?: string;
  metadata?: {
    tags?: readonly string[];
    projectContext?: string;
    filePaths?: readonly string[];
    repoUrl?: string;
    branch?: string;
    language?: string;
    sessionId?: string;
  };
  author?: {
    name?: string;
    id?: string;
  };
}

/**
 * Field names on the persisted candidate shape that are enum-constrained (carry a
 * fixed, closed vocabulary — never attacker-controlled free text) and therefore
 * do NOT need disclosure scanning. This is the ONLY hand-maintained list, and it
 * is the safe direction to hand-maintain: the structural walk scans every string
 * by default and only *skips* names on this allow-list, so forgetting to add a new
 * field here means it gets scanned (fail-safe), not bypassed (fail-open).
 *
 * Source of truth for what is enum-constrained: the Zod schemas in
 * `@qmd-team-intent-kb/schema` — `status`, `source`, `category`, `trustLevel`
 * (MemoryCandidate); `confidence`, `sensitivity` (ContentMetadata); `type`
 * (Author). The schema-coverage regression test in the store package asserts this
 * list stays aligned with the schema, so a newly-added free-text field cannot
 * silently land on it.
 */
export const ENUM_CONSTRAINED_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'source',
  'category',
  'trustLevel',
  'confidence',
  'sensitivity',
  'type',
]);

/**
 * Structurally walk a candidate-shaped object and collect every free-text string
 * surface that gets persisted, so the scanned set is DERIVED from the data rather
 * than hand-enumerated. Recurses into nested objects (metadata, author) and
 * arrays (tags, filePaths). String values are collected unless their key is on
 * {@link ENUM_CONSTRAINED_FIELDS}. Non-string scalars (numbers, booleans, null)
 * carry no PII / secret surface and are ignored.
 *
 * This is the structural fix for c5k.1: any new free-text column added to the
 * candidate shape is scanned automatically — there is no per-field list to forget
 * to update. `tenant_id` is just the first field this would have covered.
 *
 * Guards against pathological input (cyclic references, excessive nesting) so a
 * crafted object cannot turn the gate into a DoS or stack-overflow.
 */
export function collectFreeTextFields(input: unknown): string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  const MAX_DEPTH = 16;

  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (typeof value === 'string') {
      out.push(value);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (ENUM_CONSTRAINED_FIELDS.has(key)) continue;
      walk(child, depth + 1);
    }
  };

  walk(input, 0);
  return out;
}

/**
 * Error thrown by the repository-layer choke point when a candidate fails the
 * disclosure / secret gate. Carries only the category — never the matched value.
 * The store layer throws this so every write path (API, curator, spool, MCP,
 * promotion re-scan) is rejected identically and the API can map it to HTTP 422.
 */
export class DisclosureRejectedError extends Error {
  readonly category: DisclosureCategory;
  constructor(category: DisclosureCategory) {
    const kind =
      category === 'pii'
        ? 'PII'
        : category === 'secret'
          ? 'a credential / secret'
          : 'compensation / comp-split';
    // NOTE: message deliberately omits the matched value (PII non-leak).
    super(
      `Candidate rejected: content contains disallowed ${kind} material and cannot enter the governed brain.`,
    );
    this.name = 'DisclosureRejectedError';
    this.category = category;
  }
}

/**
 * Assert a candidate is clean, or throw {@link DisclosureRejectedError}. This is
 * the function the repository-layer choke point calls on every insert.
 *
 * The scanned-field set is **derived structurally** from the candidate object via
 * {@link collectFreeTextFields}: every persisted string surface is scanned —
 * `content`, `title`, `tenantId`, every tag, all `ContentMetadata` free-text
 * (`projectContext`, each `filePaths` entry, `repoUrl`, `branch`, `language`,
 * `sessionId`), and the `author` free-text (`name`, `id`). Enum-constrained
 * fields ({@link ENUM_CONSTRAINED_FIELDS}: `status`, `source`, `category`,
 * `trustLevel`, `confidence`, `sensitivity`, `author.type`) carry no free text and
 * are skipped by name.
 *
 * Because the set is derived (not a hand-maintained subset), any new free-text
 * column added to the persisted candidate shape is scanned automatically — this is
 * the c5k.1 fix: `tenant_id` was persisted by `insert()` but absent from the old
 * hand-enumerated list, so an SSN-shaped / comp-shaped `tenant_id` reached durable
 * state. `tenant_id` is reachable by non-API callers (bulk import, spool, ICO
 * ingest) that may carry an untrusted value, so scanning it is mandatory.
 *
 * Fail-closed; never logs the matched value.
 *
 * @throws {DisclosureRejectedError} when any field violates the gate.
 */
export function assertDisclosureClean(candidate: DisclosureScanInput): void {
  const fields = collectFreeTextFields(candidate);
  const violation = scanDisclosureFields(fields);
  if (violation !== null) {
    throw new DisclosureRejectedError(violation.category);
  }
}
