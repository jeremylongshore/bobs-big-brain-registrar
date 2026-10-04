import type { SecretPattern } from '../types.js';
import { SECRET_PATTERNS } from './patterns.js';

/** Redact all secret matches in content, replacing with [REDACTED:{patternId}] */
export function redactSecrets(
  content: string,
  patterns: SecretPattern[] = SECRET_PATTERNS,
): string {
  let result = content;
  for (const pattern of patterns) {
    // Honor a pattern's context gate so the redactor stays consistent with
    // scanForSecrets (bead compile-then-govern-e06.15): a context-gated pattern
    // (e.g. heroku-api-key, a bare-UUID regex) only redacts when the required
    // key-context is present in the content — otherwise a benign UUID in prose
    // would be needlessly redacted, disagreeing with the scanner that no longer
    // flags it. Over-redaction is the safe direction, but the two must agree.
    if (pattern.requiresContext && !pattern.requiresContext.test(result)) {
      continue;
    }
    const flags = pattern.regex.flags.includes('g')
      ? pattern.regex.flags
      : pattern.regex.flags + 'g';
    const replacement = `[REDACTED:${pattern.id}]`;
    const { accept } = pattern;
    if (!accept) {
      result = result.replace(new RegExp(pattern.regex.source, flags), replacement);
      continue;
    }
    // Same agreement rule for a value predicate: only a match the scanner would
    // COUNT is redacted, so a documentation placeholder (which the scanner does
    // not flag) is left readable. `replace` passes `(match, ...groups, offset,
    // input[, namedGroups])`; everything before the numeric offset is the
    // `[fullMatch, ...captureGroups]` tuple `accept` expects.
    result = result.replace(new RegExp(pattern.regex.source, flags), (...args: unknown[]) => {
      const offsetIndex = args.findIndex((arg) => typeof arg === 'number');
      const groups = args.slice(0, offsetIndex) as (string | undefined)[];
      return accept(groups) ? replacement : (groups[0] ?? '');
    });
  }
  return result;
}
