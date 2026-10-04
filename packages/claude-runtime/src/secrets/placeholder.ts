/**
 * Placeholder detection for value-bearing secret patterns.
 *
 * `prose-password` and `url-embedded-credentials` match a SHAPE (a quoted value
 * after "password is", the `user:secret@` part of a URL). Documentation uses the
 * same shapes with stand-in values — `scheme://username:password@host`,
 * `password is "<your password>"`, `postgres://app:${PGPASSWORD}@db`. These
 * predicates separate a stand-in from a real value so the patterns stay precise.
 *
 * Pure, deterministic, bounded (anchored or single-pass regexes over a value
 * the calling pattern has already length-capped). Nothing here logs or returns
 * the value it inspects.
 */

/** Template / variable syntax: `<...>`, `${...}`, `$VAR`, `{...}`, `{{...}}`, `[...]`, `%s`. */
const TEMPLATE_PREFIX = /^[<${[%]/;

/** A stand-in word anywhere in the value marks the whole value as a stand-in. */
const PLACEHOLDER_FRAGMENT =
  /password|passwd|passphrase|change[-_]?me|example|placeholder|redacted|x{3,}|\*{3,}|\.{3,}/i;

/** A reference to where the secret lives, not the secret. */
const ENV_REFERENCE = /process\.env|os\.environ|getenv|secrets\./i;

/** `DB_PASSWORD`, `PGPASS_FILE` — an environment-variable NAME. */
const ENV_VAR_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Words that carry no secret. A value whose every alphabetic word is in this
 * set (`pass`, `your-secret`, `my_token`, `enabled`) is a stand-in or a status
 * word. Deliberately does NOT include weak-but-real passwords (`admin`, `root`,
 * `test`): those are worth flagging.
 */
const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set([
  'pass',
  'pwd',
  'pw',
  'secret',
  'secrets',
  'token',
  'key',
  'apikey',
  'sample',
  'dummy',
  'hidden',
  'masked',
  'your',
  'my',
  'the',
  'here',
  'value',
  'string',
  'text',
  'foo',
  'bar',
  'baz',
  'user',
  'username',
  'enabled',
  'disabled',
  'required',
  'optional',
  'unknown',
  'missing',
  'invalid',
  'correct',
  'incorrect',
  'empty',
  'hashed',
  'encrypted',
  'rotated',
  'expired',
  'stored',
]);

/** A filesystem path or a file name — where a secret is kept, not the secret. */
const PATH_LIKE = /^(?:~|\.{1,2})?\//;
const FILE_LIKE =
  /\.(?:ya?ml|json|env|txt|md|sops|conf|cfg|ini|toml|ts|js|py|sh|key|pem|db|kdbx|age|gpg)$/i;

/**
 * True when `raw` is an obvious stand-in for a secret rather than a secret:
 * template syntax, a placeholder word, an env-var reference, or an env-var name.
 */
export function isPlaceholderSecretValue(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0) return true;
  if (TEMPLATE_PREFIX.test(value)) return true;
  if (PLACEHOLDER_FRAGMENT.test(value)) return true;
  if (ENV_REFERENCE.test(value)) return true;
  if (ENV_VAR_NAME.test(value)) return true;
  const words = value
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 0);
  return words.length > 0 && words.every((word) => PLACEHOLDER_WORDS.has(word));
}

/** True when `raw` names a path or file (`~/.pgpass`, `secrets.prod.sops.yaml`). */
export function isPathLikeValue(raw: string): boolean {
  const value = raw.trim();
  return PATH_LIKE.test(value) || FILE_LIKE.test(value);
}
