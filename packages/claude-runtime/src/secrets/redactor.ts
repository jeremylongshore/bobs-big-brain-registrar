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
    result = result.replace(
      new RegExp(pattern.regex.source, pattern.regex.flags + 'g'),
      `[REDACTED:${pattern.id}]`,
    );
  }
  return result;
}
