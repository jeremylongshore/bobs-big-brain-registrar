import type { SecretPattern } from '../types.js';
import { isPathLikeValue, isPlaceholderSecretValue } from './placeholder.js';

/** Named secret detection patterns for v1 */
export const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: 'jwt',
    name: 'JWT Token',
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    description: 'JSON Web Token (three base64url segments)',
  },
  {
    id: 'aws-key',
    name: 'AWS Access Key',
    regex: /AKIA[0-9A-Z]{16}/,
    description: 'AWS IAM access key ID',
  },
  {
    id: 'github-token',
    name: 'GitHub Token',
    regex: /gh[pousr]_[A-Za-z0-9_]{36,}/,
    description: 'GitHub personal access token, OAuth, or app token',
  },
  {
    id: 'generic-api-key',
    name: 'Generic API Key (sk-*)',
    regex: /sk-[A-Za-z0-9]{20,}/,
    description: 'API key with sk- prefix (OpenAI, Stripe, etc.)',
  },
  {
    id: 'slack-token',
    name: 'Slack Token',
    regex: /xox[bpras]-[0-9A-Za-z-]{10,}/,
    description: 'Slack bot, user, or app token',
  },
  {
    id: 'pem-key',
    name: 'PEM Private Key',
    regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
    description: 'PEM-encoded private key header',
  },
  {
    id: 'connection-string',
    name: 'Connection String with Credentials',
    regex: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^:]+:[^@]+@/,
    description: 'Database or service connection string with embedded credentials',
  },
  {
    id: 'base64-auth',
    name: 'Base64 Authorization Header',
    regex: /Basic\s+[A-Za-z0-9+/]{20,}={0,2}/,
    description: 'HTTP Basic auth header with Base64-encoded credentials',
  },
  {
    id: 'gcp-service-account',
    name: 'GCP Service Account JSON',
    regex: /"type"\s*:\s*"service_account"/,
    description: 'Google Cloud service account key file marker',
  },
  {
    id: 'high-entropy-hex',
    name: 'High-Entropy Hex String',
    regex: /[a-f0-9]{40,}/,
    description: 'Long hex string that may be a secret key or hash (40+ chars)',
  },
  {
    id: 'env-secret',
    name: 'Environment Variable Secret',
    regex: /(?:SECRET|PASSWORD|TOKEN|API_KEY|PRIVATE_KEY)\s*=\s*["']?[^\s"']{8,}/i,
    description: 'Environment variable assignment containing a secret value',
  },
  {
    id: 'azure-connection-string',
    name: 'Azure Connection String',
    regex: /AccountKey=[A-Za-z0-9+/=]{20,}/,
    description: 'Azure Storage or Service Bus connection string with AccountKey',
  },
  {
    id: 'heroku-api-key',
    name: 'Heroku API Key',
    regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    description: 'Heroku API key (UUID format), only in key-context',
    // A Heroku API key is UUID-shaped, but so is a request id, a trace id, or a
    // bead id in ordinary prose. Firing on any bare UUID over-blocks benign
    // memories (the e06.3 eval's `neg-uuid-in-prose-01` false positive dragged
    // secret-scanner + content-classifier precision below 1.0). Gate the rule
    // behind key-context: only flag a UUID as a credential when a `heroku` /
    // `api` / `key` / `token` keyword, or an assignment/secret env var, is
    // present in the same scan window. A REAL Heroku key still fires (it is set
    // via `HEROKU_API_KEY=` or referenced with those words); a naked UUID in
    // prose does not. Precision up, recall held (bead compile-then-govern-e06.15).
    //
    // Keyword boundaries are separator-based `(?:^|[^a-z0-9])…(?:[^a-z0-9]|$)`
    // rather than `\b`, so an underscored env-var token (`HEROKU_API_KEY`, where
    // `\bkey\b` would fail because `_` is a word char) still satisfies the gate.
    // The final alternative matches an env-var-style assignment (`FOO=` / `FOO:`).
    // Linear-time (no nested quantifiers) — ReDoS-safe.
    requiresContext:
      /(?:^|[^a-z0-9])(?:heroku|api[-_ ]?key|api|key|token|secret|credential|bearer)(?:[^a-z0-9]|$)|[A-Za-z][A-Za-z0-9_]*\s*[:=]/i,
  },
  {
    id: 'mysql-connection-string',
    name: 'MySQL Connection String',
    regex: /mysql:\/\/[^:]+:[^@]+@[^\s]+/,
    description: 'MySQL connection string with embedded password',
  },
  {
    id: 'postgres-connection-string',
    name: 'PostgreSQL Connection String',
    regex: /postgres(?:ql)?:\/\/[^:]+:[^@]+@[^\s]+/,
    description: 'PostgreSQL connection string with embedded password',
  },
  {
    id: 'prose-password',
    name: 'Password Stated in Prose',
    // A password written as a SENTENCE, which no key=value or token-shaped rule
    // sees: "The sudo password for the migration is `…`", "the recommended sudo
    // password for <user> is `…`", `"password": "…"`. Shape: the keyword, at most
    // 40 same-line characters, then `is` / `was` / `:` / `=`, then a quoted or
    // backticked value of 6–128 non-whitespace characters (group 1).
    //
    // Precision comes from three places. (1) The value must be QUOTED — the bare
    // word "password", `password: <your password>` and `password = os.environ[…]`
    // have no quoted value and never match. (2) The value has no whitespace — a
    // quoted phrase ("not stored anywhere") is prose. (3) `accept` rejects
    // stand-ins, env-var references and file paths. The whitespace-stripped view
    // is skipped because it would glue such a phrase into a password-shaped token.
    //
    // Linear time: one bounded lazy window (≤40) per keyword, bounded value class.
    regex:
      /(?:password|passwd|passphrase)[^\n]{0,40}?(?:\b(?:is|was)\b\s*[:=]?|[:=])\s*[*_]{0,3}[`"'“‘]([^\s`"'“”‘’]{6,128})[`"'”’]/i,
    description:
      'Password stated in a sentence or key/value pair with a quoted or backticked value',
    accept: (match) => {
      const value = match[1] ?? '';
      return !isPlaceholderSecretValue(value) && !isPathLikeValue(value);
    },
    skipWhitespaceStrippedView: true,
  },
  {
    id: 'url-embedded-credentials',
    name: 'URL with Embedded Credentials',
    // `scheme://user:secret@host` for ANY scheme (the scheme-specific rules above
    // only know five). Group 1 = user, group 2 = secret. The secret class
    // excludes `/ ? # @` and whitespace — in a real URL those are percent-encoded
    // inside userinfo — so `http://host:8080/path@x` and
    // `http://host:3000?email=a@b` (a PORT, not a password) never match.
    //
    // `accept` rejects documentation placeholders: `username:password`,
    // `user:pass`, `<password>`, `${DB_PASSWORD}`, `{password}`, `changeme`, …
    // Linear time: every quantified class is bounded and mutually delimited.
    regex: /\b[a-z][a-z0-9+.-]{1,31}:\/\/([^\s:@/?#]{0,128}):([^\s@/?#]{3,256})@[^\s@/?#:]/i,
    description: 'URL of any scheme carrying user:secret@ credentials (placeholders excluded)',
    accept: (match) => !isPlaceholderSecretValue(match[2] ?? ''),
    skipWhitespaceStrippedView: true,
  },
];

/** PII detection patterns */
export const PII_PATTERNS: SecretPattern[] = [
  {
    id: 'email-address',
    name: 'Email Address',
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    description: 'Email address',
  },
  {
    id: 'us-phone',
    name: 'US Phone Number',
    regex: /(?:\+1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/,
    description: 'US phone number in various formats',
  },
  {
    id: 'ssn-like',
    name: 'SSN-like Pattern',
    regex: /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/,
    description: 'Social Security Number pattern (XXX-XX-XXXX)',
  },
  // The three patterns below converge this classifier's PII vocabulary UP to the
  // repository-boundary disclosure filter's PII_PATTERN
  // (@qmd-team-intent-kb/common). The boundary filter caught SSN keyword, DOB,
  // and background-check terms; classifyContent did not, so a DOB-only leak
  // passed the policy pipeline (which gates on classifyContent) and was caught
  // only at the write boundary — the two vocabularies had drifted, and the
  // classifier was the weaker one (the e06.3 eval's `pii-inline-dob-01`
  // documented gap). Adding these TIGHTENS detection (the safe direction) so the
  // policy pipeline rejects DOB / background-check / SSN-keyword PII pre-boundary
  // too. Bounded character classes only — linear time, no ReDoS surface.
  {
    id: 'ssn-keyword',
    name: 'SSN Keyword',
    regex: /\bSSN\b|social security (?:number|no)/i,
    description: 'Social Security Number referenced by keyword (SSN / social security number)',
  },
  {
    id: 'date-of-birth',
    name: 'Date of Birth',
    regex: /date of birth|\bDOB\b\s*[:=]/i,
    description: 'Date-of-birth disclosure (date of birth / DOB: / DOB=)',
  },
  {
    id: 'background-check',
    name: 'Background Check Data',
    regex: /background[- ]check (?:result|report|passed|failed)/i,
    description: 'Background-check result/report disclosure',
  },
];
