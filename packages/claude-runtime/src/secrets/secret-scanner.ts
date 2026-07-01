import type { SecretMatch, SecretPattern } from '../types.js';
import { SECRET_PATTERNS } from './patterns.js';

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
function scanFlat(
  text: string,
  patterns: SecretPattern[],
  matches: SecretMatch[],
  locate: (matchIndex: number, matchLength: number) => { line: number; column: number },
  patternIdOverride?: (patternId: string) => string,
): void {
  for (const pattern of patterns) {
    // A global/sticky regex carries `lastIndex` across `.exec()` calls, which
    // would make matching nondeterministic across separate scan invocations.
    // Reset it so scanFlat stays pure regardless of a custom pattern's flags.
    if (pattern.regex.global || pattern.regex.sticky) {
      pattern.regex.lastIndex = 0;
    }
    const match = pattern.regex.exec(text);
    if (match) {
      const { line, column } = locate(match.index, match[0].length);
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

/**
 * Newline-collapsed pre-pass (evasion A — split-across-newline keys).
 *
 * The per-line scan cannot see a key whose characters straddle a `\n`. We build
 * a whitespace-collapsed view (every run of whitespace, incl. newlines, becomes
 * a single space) AND a no-whitespace view, and re-run the patterns over both.
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
): void {
  if (content.length > LIMITS.collapsedScanMaxChars) return;
  // Two views: a single-space collapse (preserves token boundaries so, e.g., an
  // env-secret assignment still reads as KEY = value) and a no-whitespace view
  // (rejoins a key literally broken mid-token across a newline).
  const singleSpace = content.replace(/\s+/g, ' ');
  const noWhitespace = content.replace(/\s+/g, '');
  const remaining = patterns.filter((p) => !alreadyFired.has(p.id));
  if (remaining.length === 0) return;
  // Best-effort location: collapsed views lose source coordinates, so report the
  // first line. Column is 1 (start-of-view) — a signal, not a precise offset.
  const locate = () => ({ line: 1, column: 1 });
  const before = matches.length;
  scanFlat(singleSpace, remaining, matches, locate);
  // Only try the no-whitespace view for patterns STILL unmatched, to catch a key
  // broken mid-token (which the single-space view leaves as two tokens).
  const stillUnmatched = remaining.filter(
    (p) => !matches.slice(before).some((m) => m.patternId === p.id),
  );
  if (stillUnmatched.length > 0) scanFlat(noWhitespace, stillUnmatched, matches, locate);
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
): void {
  let decodedCandidates = 0;
  let decodedBytes = 0;
  const seenWrapped = new Set<string>();

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

    const decoded = decode(raw);
    if (decoded === null || decoded.length === 0) return;
    decodedCandidates += 1;
    decodedBytes += decoded.length;
    // Best-effort location: the candidate's ACTUAL match offset in the ORIGINAL
    // content (threaded from matchAll's `m.index`), on the line it starts. Using
    // the real index is correct when the same blob appears more than once —
    // `content.indexOf(raw)` would always report the first occurrence.
    const line = index >= 0 ? content.slice(0, index).split('\n').length : 1;
    const column = index >= 0 ? index - content.lastIndexOf('\n', index) : 1;
    scanFlat(
      decoded,
      patterns,
      matches,
      () => ({ line, column: Math.max(1, column) }),
      (patternId) => {
        const wrappedId = `${prefix}:${patternId}`;
        return wrappedId;
      },
    );
    // Dedup guard: track the wrapped prefix so the same blob is not re-scanned.
    seenWrapped.add(raw);
  };

  // Base64 candidates (standard + url-safe). Normalise url-safe to standard and
  // pad before decoding; reject anything that does not round-trip to valid text.
  for (const m of content.matchAll(BASE64_CANDIDATE_RE)) {
    if (decodedCandidates >= LIMITS.maxEncodedCandidates) break;
    if (decodedBytes >= LIMITS.maxTotalDecodedBytes) break;
    const raw = m[0];
    if (seenWrapped.has(raw)) continue;
    tryDecode(raw, m.index ?? -1, decodeBase64, 'base64-wrapped');
  }

  // Hex candidates (even-length runs of hex). Cheap second encoded form.
  for (const m of content.matchAll(HEX_CANDIDATE_RE)) {
    if (decodedCandidates >= LIMITS.maxEncodedCandidates) break;
    if (decodedBytes >= LIMITS.maxTotalDecodedBytes) break;
    const raw = m[0];
    if (seenWrapped.has(raw) || raw.length % 2 !== 0) continue;
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

  // Pass 1 — the original per-line scan (UNCHANGED; the split/encoded passes are
  // additive backstops layered on top, never a replacement).
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    for (const pattern of patterns) {
      // Same determinism guard as scanFlat: a global/sticky custom pattern
      // would otherwise carry `lastIndex` across lines and skip matches.
      if (pattern.regex.global || pattern.regex.sticky) {
        pattern.regex.lastIndex = 0;
      }
      const match = pattern.regex.exec(line);
      if (match) {
        matches.push({
          patternId: pattern.id,
          patternName: pattern.name,
          line: lineIdx + 1,
          column: match.index + 1,
          matchLength: match[0].length,
        });
      }
    }
  }

  // Only the single-line content path can be split across a newline; if there is
  // no newline the collapsed pre-pass would just re-scan the same text.
  if (content.includes('\n')) {
    const firedOnLineScan = new Set(matches.map((m) => m.patternId));
    scanNewlineCollapsed(content, patterns, firedOnLineScan, matches);
  }

  // Pass 3 — bounded decode-and-rescan of encoded-looking blobs.
  scanEncodedWrapped(content, patterns, matches);

  return matches;
}

/** Check if content contains any secrets */
export function hasSecrets(content: string, patterns: SecretPattern[] = SECRET_PATTERNS): boolean {
  return scanForSecrets(content, patterns).length > 0;
}
