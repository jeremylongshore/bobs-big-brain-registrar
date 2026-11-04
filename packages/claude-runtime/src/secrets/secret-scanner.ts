import type { SecretMatch, SecretPattern } from '../types.js';
import { SECRET_PATTERNS } from './patterns.js';
import { mappedWhitespace, SourceContext } from './source-context.js';

/**
 * Bounds for the evasion-hardening pre-passes. Kept explicit so `scanForSecrets`
 * stays a pure, deterministic, DoS-resistant function regardless of input size.
 *
 * Rationale (bead compile-then-govern-e06.14 · umbrella #27): the e06.3
 * govern-decision eval measured secret-scanner recall at 0.56 because two
 * evasions defeat the line-by-line scan — a key SPLIT across a newline, and a
 * token BASE64/hex-WRAPPED so no pattern matches the encoded form. The fixes
 * below add a newline-collapsed view and a bounded decode-and-rescan; the caps
 * guarantee the extra work is bounded even for pathological input.
 */
const LIMITS = {
  /** Max content length (chars) the newline-collapsed pre-pass will process. */
  collapsedScanMaxChars: 512 * 1024,
  /** Min length of a base64/hex candidate substring worth decoding (avoids noise). */
  minEncodedCandidateLen: 24,
  /** Max length of a single encoded candidate we will decode (bounds one decode). */
  maxEncodedCandidateLen: 8 * 1024,
  /** Max number of encoded candidates decoded per scan (bounds candidate count). */
  maxEncodedCandidates: 64,
  /** Max total decoded bytes across all candidates (bounds aggregate decode work). */
  maxTotalDecodedBytes: 256 * 1024,
} as const;

/** Base64 substrings: standard + url-safe alphabet, length >= min (padding optional). */
const BASE64_CANDIDATE_RE = /[A-Za-z0-9+/_-]{24,}={0,2}/g;
/** Long hex blobs (even length), a cheap second encoded form. */
const HEX_CANDIDATE_RE = /[A-Fa-f0-9]{24,}/g;

/**
 * Scan a single flat string against every pattern and push each first match.
 * `line`/`column` are relative to `originText` (the caller supplies how to map
 * a hit back to a source location — best-effort for the derived views).
 */
/**
 * Run one pattern against `text` and return its first match, honoring the
 * pattern's optional context gate. Centralises two invariants for every scan
 * pass (per-line, collapsed, decoded):
 *
 *   1. Determinism — a global/sticky regex carries `lastIndex` across `.exec()`
 *      calls, which would make matching nondeterministic across invocations, so
 *      reset it (and the context regex) before use.
 *   2. Context gate — when `pattern.requiresContext` is set, the value matching
 *      is not sufficient: a context window must ALSO satisfy the context regex,
 *      else the hit is suppressed. This lets an ambiguous value (a bare UUID)
 *      only count as a credential when key-context is nearby, raising precision
 *      without weakening any context-free rule.
 *
 * The context window is `contextText` when supplied, else `text`. This matters
 * for the decode-and-rescan pass: the DECODED blob (`text`) is just the raw
 * value (e.g. a bare UUID) with no surrounding keywords, so the context gate
 * must be evaluated against the ORIGINAL content the blob came from
 * (`contextText`) — otherwise a real base64/hex-wrapped Heroku key surrounded by
 * `heroku` / `api key` context would be silently missed (Gemini finding, e06.15).
 * For the per-line and collapsed passes the value and its context live in the
 * same string, so `contextText` is omitted and the window is `text` itself.
 * Source-associated patterns instead receive a per-match predicate that checks
 * their original occurrence (or decoded-local context). Its accepted match
 * already satisfies the gate; no whole-document keyword fallback is applied.
 *
 * Returns the RegExpExecArray for a counted hit, or `null` when the pattern does
 * not match or its context gate is not satisfied.
 */
/**
 * First match of `pattern.regex` in `text` that counts on value alone.
 *
 * Without a value predicate this is the plain first match (determinism: a
 * global/sticky regex carries `lastIndex`, so it is reset first). With
 * `pattern.accept`, EVERY match in the window is examined and the first accepted
 * one wins — otherwise a documentation placeholder earlier on a line would hide
 * a real credential later on the same line. The walk runs on a private global
 * copy of the regex, so no shared `lastIndex` state is touched.
 */
function firstCountedMatch(
  pattern: SecretPattern,
  text: string,
  acceptSource?: (match: RegExpExecArray) => boolean,
): RegExpExecArray | null {
  if (!pattern.accept && !acceptSource) {
    if (pattern.regex.global || pattern.regex.sticky) {
      pattern.regex.lastIndex = 0;
    }
    return pattern.regex.exec(text);
  }
  const flags = pattern.regex.flags.includes('g') ? pattern.regex.flags : pattern.regex.flags + 'g';
  const walker = new RegExp(pattern.regex.source, flags);
  let match = walker.exec(text);
  while (match !== null) {
    const sourceAccepted = !acceptSource || acceptSource(match);
    if ((!pattern.accept || pattern.accept(match)) && sourceAccepted) return match;
    // A rejected joined-word match may consume the first letters of a later
    // valid prefix. Resume after its START so that overlapping candidate is not
    // hidden. Existing value-predicate walks otherwise retain their behavior.
    if (!sourceAccepted) walker.lastIndex = match.index + 1;
    else if (match[0].length === 0) walker.lastIndex += 1;
    match = walker.exec(text);
  }
  return null;
}

function execWithContext(
  pattern: SecretPattern,
  text: string,
  contextText?: string,
  acceptSource?: (match: RegExpExecArray) => boolean,
): RegExpExecArray | null {
  const match = firstCountedMatch(pattern, text, acceptSource);
  if (!match) return null;
  if (pattern.requiresContext && !(pattern.requiresSourceContext && acceptSource)) {
    if (pattern.requiresContext.global || pattern.requiresContext.sticky) {
      pattern.requiresContext.lastIndex = 0;
    }
    // Evaluate the gate against the context window (the original content for a
    // decoded blob; the text itself otherwise). Suppress unless it carries
    // key-context.
    const window = contextText ?? text;
    if (!pattern.requiresContext.test(window)) return null;
  }
  return match;
}

function scanFlat(
  text: string,
  patterns: SecretPattern[],
  matches: SecretMatch[],
  locate: (
    matchIndex: number,
    matchLength: number,
    pattern: SecretPattern,
  ) => { line: number; column: number },
  patternIdOverride?: (patternId: string) => string,
  contextText?: string,
  acceptSource?: (pattern: SecretPattern, match: RegExpExecArray) => boolean,
): void {
  for (const pattern of patterns) {
    // `contextText` (when supplied) is the window a context-gated pattern's gate
    // is evaluated against — used by the decode pass so a wrapped value is gated
    // on the ORIGINAL content, not just the context-free decoded blob.
    const match = execWithContext(
      pattern,
      text,
      contextText,
      acceptSource ? (item) => acceptSource(pattern, item) : undefined,
    );
    if (match) {
      const { line, column } = locate(match.index, match[0].length, pattern);
      matches.push({
        patternId: patternIdOverride ? patternIdOverride(pattern.id) : pattern.id,
        patternName: pattern.name,
        line,
        column,
        matchLength: match[0].length,
      });
    }
  }
}

/** Join padded line wraps, retaining purely horizontal whitespace runs. */
function joinLineWraps(text: string): string {
  return text.replace(/\s+/g, (space) => (/[\r\n\u2028\u2029]/.test(space) ? '' : space));
}

/**
 * Newline-collapsed pre-pass (evasion A — split-across-newline keys).
 *
 * The per-line scan cannot see a key whose characters straddle a `\n`. We build
 * a whitespace-collapsed view (every run becomes a single space) and additional
 * split-token views. Env/Slack patterns join only line-wrap runs; other eligible
 * patterns use the fully whitespace-stripped view with their source guards.
 * A hit that the per-line scan already found is deduped by (patternId) — we only
 * add a collapsed-view hit for a pattern the line scan did not already fire on,
 * so the split-key case surfaces without double-counting inline hits. Line/
 * column reporting is best-effort: we report the first source line (1).
 */
function scanNewlineCollapsed(
  content: string,
  patterns: SecretPattern[],
  alreadyFired: Set<string>,
  matches: SecretMatch[],
  sourceContext?: SourceContext,
): void {
  if (content.length > LIMITS.collapsedScanMaxChars) return;
  // First preserve token boundaries, so an assignment still reads KEY = value.
  const singleSpace = mappedWhitespace(content, true);
  const remaining = patterns.filter((p) => !alreadyFired.has(p.id));
  if (remaining.length === 0) return;
  // Best-effort location: collapsed views lose source coordinates, so report the
  // first line. Column is 1 (start-of-view) — a signal, not a precise offset.
  const locate = () => ({ line: 1, column: 1 });
  const before = matches.length;
  const acceptedContext = (pattern: SecretPattern, match: RegExpExecArray, offsets: number[]) => {
    if (!pattern.requiresSourceContext) return true;
    const start = offsets[match.index];
    const end = offsets[match.index + match[0].length - 1];
    return (
      start !== undefined &&
      end !== undefined &&
      sourceContext?.allows(pattern, start, end + 1) === true
    );
  };
  const sourceLocation = (index: number, pattern: SecretPattern, offsets: number[]) =>
    pattern.requiresSourceContext && sourceContext && offsets[index] !== undefined
      ? sourceContext.locate(offsets[index]!)
      : locate();
  scanFlat(
    singleSpace.text,
    remaining,
    matches,
    (index, _length, pattern) => sourceLocation(index, pattern, singleSpace.offsets),
    undefined,
    undefined,
    (pattern, match) => acceptedContext(pattern, match, singleSpace.offsets),
  );
  // Env/Slack values must not be fabricated by concatenating ordinary words.
  // Normalize ONCE, then scan directly: per-candidate suffix validation would
  // repeatedly rescan greedy values on many short assignments.
  const wrapOnly = remaining.filter(
    (p) =>
      p.lineWrapOnly === true &&
      p.skipWhitespaceStrippedView !== true &&
      !matches.slice(before).some((m) => m.patternId === p.id),
  );
  if (wrapOnly.length > 0) scanFlat(joinLineWraps(content), wrapOnly, matches, locate);
  // Only try the no-whitespace view for patterns STILL unmatched, to catch a key
  // broken mid-token (which the single-space view leaves as two tokens).
  // A pattern that opts out (`skipWhitespaceStrippedView`) depends on whitespace
  // for its precision, so it is never run against the stripped view.
  const stillUnmatched = remaining.filter(
    (p) =>
      p.skipWhitespaceStrippedView !== true &&
      p.lineWrapOnly !== true &&
      !matches.slice(before).some((m) => m.patternId === p.id),
  );
  if (stillUnmatched.length === 0) return;
  // Preserve UTF-16 offsets into the original source. Validate the source token
  // before applying the fragment-prefix guard, so a genuine line-wrapped key
  // attached to an identifier remains visible. The existing input cap bounds
  // the map and each source slice.
  const stripped = mappedWhitespace(content, false);
  const offsets = stripped.offsets;
  scanFlat(
    stripped.text,
    stillUnmatched,
    matches,
    (index, _length, pattern) => sourceLocation(index, pattern, offsets),
    undefined,
    undefined,
    (pattern, match) => {
      if (!acceptedContext(pattern, match, offsets)) return false;
      if (!pattern.requiresSourceToken) return true;
      const start = offsets[match.index];
      const end = offsets[match.index + match[0].length - 1];
      if (start === undefined || end === undefined) return false;
      // Join line-wrap whitespace, including padding and Unicode separators, keeping
      // ordinary horizontal spaces. Only a real matching prefix must survive:
      // the greedy stripped match may also contain subsequent prose words.
      const source = joinLineWraps(content.slice(start, end + 1));
      if (firstCountedMatch(pattern, source)?.index === 0) return true;
      // A genuinely standalone key prefix may also have horizontal fragments.
      // Without a source token, however, a prefix immediately after a letter
      // (the suffix of `task-`, for example) must not manufacture a key. Do not
      // look through newline boundaries: unrelated prior prose must never hide
      // a standalone fragmented key on the next line.
      return start === 0 || !/[A-Za-z]/.test(content[start - 1]!);
    },
  );
}

/**
 * Bounded base64/hex decode-and-rescan (evasion B — encoded-wrapped tokens).
 *
 * There is no decode step in the line scan, so an `AKIA…`/JWT/etc. base64- or
 * hex-encoded in content evades every pattern. We find encoded-looking
 * substrings (valid alphabet, >= a sane min length), decode a BOUNDED number of
 * them (bounded total size — see LIMITS), and re-run the secret patterns over
 * the decoded text. A hit is reported with its patternId prefixed
 * `base64-wrapped:`/`hex-wrapped:` so downstream can see it was an encoded leak.
 * The caps make this DoS-resistant: at most `maxEncodedCandidates` decodes and
 * `maxTotalDecodedBytes` decoded bytes, whatever the input.
 */
function scanEncodedWrapped(
  content: string,
  patterns: SecretPattern[],
  matches: SecretMatch[],
  sourceContext?: SourceContext,
): void {
  let decodedCandidates = 0;
  let decodedBytes = 0;
  const seenWrapped = new Set<string>();
  const decodedCache = new Map<string, { text: string; encoding: string }>();
  const occurrencePatterns = patterns.filter((p) => p.requiresSourceContext);

  const tryDecode = (
    raw: string,
    index: number,
    decode: (s: string) => string | null,
    prefix: string,
  ): void => {
    if (decodedCandidates >= LIMITS.maxEncodedCandidates) return;
    if (raw.length < LIMITS.minEncodedCandidateLen) return;
    if (raw.length > LIMITS.maxEncodedCandidateLen) return;
    if (decodedBytes >= LIMITS.maxTotalDecodedBytes) return;

    const cached = decodedCache.get(raw);
    // Preserve the existing cross-codec dedup: bytes first decoded as base64
    // must not later be interpreted as a cached hex decode (or vice versa).
    if (cached && cached.encoding !== prefix) return;
    const decoded = cached?.text ?? decode(raw);
    if (decoded === null || decoded.length === 0) return;
    if (cached === undefined) {
      decodedCandidates += 1;
      decodedBytes += decoded.length;
      decodedCache.set(raw, { text: decoded, encoding: prefix });
    }
    // Best-effort location: the candidate's ACTUAL match offset in the ORIGINAL
    // content (threaded from matchAll's `m.index`), on the line it starts. Using
    // the real index is correct when the same blob appears more than once —
    // `content.indexOf(raw)` would always report the first occurrence.
    let legacyLocation: { line: number; column: number } | undefined;
    const decodedContext = new SourceContext(decoded);
    scanFlat(
      decoded,
      seenWrapped.has(raw) ? occurrencePatterns : patterns,
      matches,
      (_matchIndex, _length, pattern) => {
        if (pattern.requiresSourceContext && sourceContext) return sourceContext.locate(index);
        legacyLocation ??= {
          line: index >= 0 ? content.slice(0, index).split('\n').length : 1,
          column: index >= 0 ? Math.max(1, index - content.lastIndexOf('\n', index)) : 1,
        };
        return legacyLocation;
      },
      (patternId) => {
        const wrappedId = `${prefix}:${patternId}`;
        return wrappedId;
      },
      // Legacy custom context gates retain the original window. Heroku's
      // source predicate below instead associates context with this occurrence
      // or with the matching value's decoded source lines.
      content,
      (pattern, match) =>
        !pattern.requiresSourceContext ||
        sourceContext?.allows(pattern, index, index + raw.length) === true ||
        decodedContext.allows(pattern, match.index, match.index + match[0].length),
    );
    // Context-free findings remain deduped. Repeated source-sensitive occurrences
    // reuse decoded bytes and evaluate their own context without another decode.
    seenWrapped.add(raw);
  };

  // Base64 candidates (standard + url-safe). Normalise url-safe to standard and
  // pad before decoding; reject anything that does not round-trip to valid text.
  for (const m of content.matchAll(BASE64_CANDIDATE_RE)) {
    if (decodedCandidates >= LIMITS.maxEncodedCandidates) break;
    if (decodedBytes >= LIMITS.maxTotalDecodedBytes) break;
    const raw = m[0];
    if (seenWrapped.has(raw) && occurrencePatterns.length === 0) continue;
    tryDecode(raw, m.index ?? -1, decodeBase64, 'base64-wrapped');
  }

  // Hex candidates (even-length runs of hex). Cheap second encoded form.
  for (const m of content.matchAll(HEX_CANDIDATE_RE)) {
    if (decodedCandidates >= LIMITS.maxEncodedCandidates) break;
    if (decodedBytes >= LIMITS.maxTotalDecodedBytes) break;
    const raw = m[0];
    if ((seenWrapped.has(raw) && occurrencePatterns.length === 0) || raw.length % 2 !== 0) continue;
    tryDecode(raw, m.index ?? -1, decodeHex, 'hex-wrapped');
  }
}

/** Decode a base64 (standard or url-safe) candidate to UTF-8, or null if it is
 *  not plausibly decodable printable text. Pure — no side effects. */
function decodeBase64(candidate: string): string | null {
  // Normalise url-safe alphabet and strip any existing padding, then re-pad.
  const normalized = candidate.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  // A valid base64 body length (mod 4) is 0, 2, or 3 (1 is impossible).
  if (normalized.length % 4 === 1) return null;
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    const buf = Buffer.from(padded, 'base64');
    if (buf.length === 0) return null;
    const text = buf.toString('utf8');
    // Require the decode to be MOSTLY printable — random base64 of binary noise
    // decodes to garbage and should not be scanned (avoids wasted work + FPs).
    if (!isMostlyPrintable(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/** Decode an even-length hex candidate to UTF-8, or null if not printable text. */
function decodeHex(candidate: string): string | null {
  try {
    const buf = Buffer.from(candidate, 'hex');
    // Buffer.from is lenient with bad hex; require an exact round-trip length.
    if (buf.length === 0 || buf.length * 2 !== candidate.length) return null;
    const text = buf.toString('utf8');
    if (!isMostlyPrintable(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/** True when at least 90% of chars are printable ASCII (secrets are ASCII). */
function isMostlyPrintable(text: string): boolean {
  if (text.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Printable ASCII range + common whitespace.
    if ((code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d) {
      printable += 1;
    }
  }
  return printable / text.length >= 0.9;
}

/**
 * Scan content for secret patterns. Pure function — no side effects, no network,
 * deterministic.
 *
 * Three passes, all bounded (see {@link LIMITS}):
 *  1. the original per-line scan (unchanged — never removed);
 *  2. a newline-collapsed pre-pass so a key split across two lines is caught
 *     (evasion A);
 *  3. a bounded base64/hex decode-and-rescan so an encoded-wrapped token is
 *     caught (evasion B), reported with a `base64-wrapped:`/`hex-wrapped:`
 *     patternId prefix.
 *
 * Bead compile-then-govern-e06.14 · umbrella #27 — closes the two evasions the
 * e06.3 govern-decision eval measured (secret-scanner recall 0.56).
 */
export function scanForSecrets(
  content: string,
  patterns: SecretPattern[] = SECRET_PATTERNS,
): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const lines = content.split('\n');
  const sourceContext = patterns.some((p) => p.requiresSourceContext)
    ? new SourceContext(content)
    : undefined;
  let lineStart = 0;

  // Pass 1 — the original per-line scan (behaviour unchanged for context-free
  // patterns; the split/encoded passes are additive backstops layered on top,
  // never a replacement). `execWithContext` centralises the determinism reset
  // AND the optional per-pattern context gate — a context-gated pattern (e.g.
  // heroku-api-key) only counts when key-context is present on the SAME line.
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    for (const pattern of patterns) {
      const match = execWithContext(
        pattern,
        line,
        undefined,
        pattern.requiresSourceContext
          ? (item) =>
              sourceContext?.allows(
                pattern,
                lineStart + item.index,
                lineStart + item.index + item[0].length,
              ) === true
          : undefined,
      );
      if (match) {
        const location =
          pattern.requiresSourceContext && sourceContext
            ? sourceContext.locate(lineStart + match.index)
            : { line: lineIdx + 1, column: match.index + 1 };
        matches.push({
          patternId: pattern.id,
          patternName: pattern.name,
          ...location,
          matchLength: match[0].length,
        });
      }
    }
    lineStart += line.length + 1;
  }

  // Include CR and Unicode line separators, also accepted by joinLineWraps.
  if (/[\r\n\u2028\u2029]/.test(content)) {
    const firedOnLineScan = new Set(matches.map((m) => m.patternId));
    scanNewlineCollapsed(content, patterns, firedOnLineScan, matches, sourceContext);
  }

  // Pass 3 — bounded decode-and-rescan of encoded-looking blobs.
  scanEncodedWrapped(content, patterns, matches, sourceContext);

  return matches;
}

/** Check if content contains any secrets */
export function hasSecrets(content: string, patterns: SecretPattern[] = SECRET_PATTERNS): boolean {
  return scanForSecrets(content, patterns).length > 0;
}
