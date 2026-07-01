/**
 * govern-decision adversarial labeled dataset — v1.
 *
 * A versioned (dataset/v1), self-describing set of ≥30 labeled cases that
 * measures the EFFICACY of the govern decision, not just its determinism.
 * See ./README.md for the schema, the class/surface taxonomy, and the list of
 * documented false-negatives this set proves out.
 *
 * ## Provenance of the labels (010-AT-RISK R5/R10 · bead compile-then-govern-e06.3)
 *
 * Every `expectCaughtBy` / `knownFalseNegativeOf` label was set from an
 * EMPIRICAL probe of the real scanners (claude-runtime `scanForSecrets` /
 * `classifyContent`, common `scanForDisclosure`) on this exact material — not
 * from assumption. The govern-decision eval then re-derives those outcomes and
 * fails closed if a label drifts (see the eval's undocumented-FN gate). So the
 * dataset and the code cannot silently disagree.
 *
 * The set is intentionally kept as data (this module) rather than fixtures so it
 * can be consumed by the eval, the tests, and the CI script identically.
 *
 * DATASET_VERSION is bumped on any change to the case set so the eval report,
 * the CI gate, and any future baseline can pin the exact set they scored.
 */

import type { GovernCase } from '../../types.js';

/** Semantic version of THIS labeled set. Bump on any case add/remove/relabel. */
export const DATASET_VERSION = '1.0.0';

/* -------------------------------------------------------------------------- */
/* Fixture material — realistic-shaped but non-live secrets.                   */
/*                                                                             */
/* NONE of these are real credentials: the AWS id is the AWS-published EXAMPLE */
/* value, the OpenAI/GitHub/JWT shapes are structurally valid but random. They */
/* exist only to exercise the detectors. Keeping them here (not inline in each */
/* case) documents that fact in one place.                                     */
/* -------------------------------------------------------------------------- */

/** AWS's own documented example access-key id (safe to commit). */
const AWS_EXAMPLE_KEY = 'AKIAIOSFODNN7EXAMPLE';
/** Structurally-valid OpenAI-style key (random body, not a live key). */
const OPENAI_SHAPE = 'sk-abcdefghij1234567890KLMNOPqrstuvWX';
/** Structurally-valid GitHub PAT shape (40-char body). */
const GITHUB_SHAPE = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
/** A three-segment JWT (random-ish base64url segments). */
const JWT_SHAPE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpEb2UifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
/** An SSN-shaped string. */
const SSN_SHAPE = '123-45-6789';

/** base64 of the OpenAI-shaped key — the encoded-token evasion. */
const OPENAI_B64 = Buffer.from(OPENAI_SHAPE, 'utf8').toString('base64');
/** base64 of the GitHub-shaped token. */
const GITHUB_B64 = Buffer.from(GITHUB_SHAPE, 'utf8').toString('base64');

/**
 * The labeled cases. ≥30 spanning:
 *   POSITIVES — inline / split-multiline / base64 / hex secrets; PII inline and
 *   in odd metadata fields; internal-path leaks; a tenant-spoof case.
 *   NEGATIVES — benign code + prose that merely MENTIONS "password"/"secret".
 *
 * `expectCaughtBy` = the checks a healthy moat fires; `knownFalseNegativeOf` =
 * the checks empirically confirmed to MISS the case today (documented gaps).
 */
export const GOVERN_CASES: readonly GovernCase[] = [
  /* ---------------------- SECRETS · inline (should catch) ------------------ */
  {
    id: 'sec-inline-aws-01',
    description: 'AWS access-key id inline in content',
    sensitiveClass: 'secret',
    surface: 'inline',
    candidate: { content: `Deploy uses key ${AWS_EXAMPLE_KEY} for the S3 bucket.` },
    expectCaughtBy: [
      'policy-pipeline',
      'secret-scanner',
      'content-classifier',
      'boundary-disclosure',
    ],
  },
  {
    id: 'sec-inline-openai-01',
    description: 'OpenAI-style sk- key inline in content',
    sensitiveClass: 'secret',
    surface: 'inline',
    candidate: { content: `Set OPENAI_API_KEY to ${OPENAI_SHAPE} in the env.` },
    expectCaughtBy: [
      'policy-pipeline',
      'secret-scanner',
      'content-classifier',
      'boundary-disclosure',
    ],
  },
  {
    id: 'sec-inline-github-01',
    description: 'GitHub PAT inline in content',
    sensitiveClass: 'secret',
    surface: 'inline',
    candidate: { content: `git remote set-url origin https://${GITHUB_SHAPE}@github.com/x/y.git` },
    expectCaughtBy: [
      'policy-pipeline',
      'secret-scanner',
      'content-classifier',
      'boundary-disclosure',
    ],
  },
  {
    id: 'sec-inline-jwt-01',
    description: 'JWT (three base64url segments) inline in content',
    sensitiveClass: 'secret',
    surface: 'inline',
    candidate: { content: `Authorization: Bearer ${JWT_SHAPE}` },
    expectCaughtBy: [
      'policy-pipeline',
      'secret-scanner',
      'content-classifier',
      'boundary-disclosure',
    ],
  },
  {
    id: 'sec-inline-pem-01',
    description: 'PEM private-key block header inline in content',
    sensitiveClass: 'secret',
    surface: 'inline',
    candidate: {
      content: 'The deploy key is:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...',
    },
    expectCaughtBy: [
      'policy-pipeline',
      'secret-scanner',
      'content-classifier',
      'boundary-disclosure',
    ],
  },
  {
    id: 'sec-inline-connstr-01',
    description: 'Postgres connection string with embedded credentials inline',
    sensitiveClass: 'secret',
    surface: 'inline',
    candidate: { content: 'DB is postgres://admin:hunter2pass@db.host:5432/prod for the app.' },
    // The line-based secret-scanner catches the connection-string pattern; the
    // boundary filter's SECRET_PATTERNS do not include DB connection strings.
    expectCaughtBy: ['policy-pipeline', 'secret-scanner', 'content-classifier'],
    knownFalseNegativeOf: ['boundary-disclosure'],
  },
  {
    id: 'sec-inline-envassign-01',
    description: 'Environment-variable secret assignment inline',
    sensitiveClass: 'secret',
    surface: 'inline',
    candidate: { content: 'Add API_KEY="s3cr3t-value-not-a-known-prefix-12345" to the config.' },
    // Caught by the env-secret regex in the line scanner; the boundary filter
    // is prefix-anchored to known providers and does not match a generic assign.
    expectCaughtBy: ['policy-pipeline', 'secret-scanner', 'content-classifier'],
    knownFalseNegativeOf: ['boundary-disclosure'],
  },

  /* --------- SECRETS · split across two lines (the CISO's fear) ------------ */
  {
    id: 'sec-split-openai-01',
    description: 'OpenAI-style key split across two lines (defeats line-based scan)',
    sensitiveClass: 'secret',
    surface: 'split-multiline',
    candidate: {
      content: `The key is sk-abcdefghij1234567890\nKLMNOPqrstuvWX and it authenticates.`,
    },
    // DOCUMENTED GAP: both the line-based secret scanner and the boundary
    // filter miss a key broken across a newline. This is the moat hole R5/e06.3
    // exists to surface — reported, never hidden.
    expectCaughtBy: [],
    knownFalseNegativeOf: [
      'policy-pipeline',
      'secret-scanner',
      'content-classifier',
      'boundary-disclosure',
    ],
  },
  {
    id: 'sec-split-aws-01',
    description: 'AWS access-key id split across two lines',
    sensitiveClass: 'secret',
    surface: 'split-multiline',
    candidate: { content: 'access key:\nAKIAIOSFO\nDNN7EXAMPLE\nendkey' },
    expectCaughtBy: [],
    knownFalseNegativeOf: [
      'policy-pipeline',
      'secret-scanner',
      'content-classifier',
      'boundary-disclosure',
    ],
  },

  /* --------------- SECRETS · base64-encoded (no decode step) --------------- */
  {
    id: 'sec-b64-openai-01',
    description: 'OpenAI-style key wrapped in base64 (no decode step in scanners)',
    sensitiveClass: 'secret',
    surface: 'base64-encoded',
    candidate: { content: `Decoded at runtime: ${OPENAI_B64}` },
    expectCaughtBy: [],
    knownFalseNegativeOf: [
      'policy-pipeline',
      'secret-scanner',
      'content-classifier',
      'boundary-disclosure',
    ],
  },
  {
    id: 'sec-b64-github-01',
    description: 'GitHub PAT wrapped in base64',
    sensitiveClass: 'secret',
    surface: 'base64-encoded',
    candidate: { content: `token blob = ${GITHUB_B64}` },
    expectCaughtBy: [],
    knownFalseNegativeOf: [
      'policy-pipeline',
      'secret-scanner',
      'content-classifier',
      'boundary-disclosure',
    ],
  },

  /* ----------------------- SECRETS · hex-encoded -------------------------- */
  {
    id: 'sec-hex-aws-01',
    description: 'AWS key hex-encoded (40 hex chars trips the high-entropy-hex rule)',
    sensitiveClass: 'secret',
    surface: 'hex-encoded',
    candidate: { content: `hexval ${Buffer.from(AWS_EXAMPLE_KEY, 'utf8').toString('hex')}` },
    // The line-based scanner's high-entropy-hex rule (40+ hex) fires; the
    // boundary filter has no hex rule → documented miss there.
    expectCaughtBy: ['policy-pipeline', 'secret-scanner', 'content-classifier'],
    knownFalseNegativeOf: ['boundary-disclosure'],
  },

  /* --------------------------- PII · inline ------------------------------- */
  {
    id: 'pii-inline-ssn-01',
    description: 'SSN inline in content',
    sensitiveClass: 'pii',
    surface: 'inline',
    candidate: { content: `Employee record: SSN ${SSN_SHAPE} on file.` },
    // classify + boundary flag PII; the SECRET scanner is secrets-only (SSN is
    // not a secret pattern) so it correctly does not fire — that is not a miss.
    expectCaughtBy: ['policy-pipeline', 'content-classifier', 'boundary-disclosure'],
  },
  {
    id: 'pii-inline-dob-01',
    description: 'Date-of-birth field inline in content',
    sensitiveClass: 'pii',
    surface: 'inline',
    candidate: { content: 'HR note — DOB: 1984-07-02, hired last spring.' },
    // DOCUMENTED GAP (real finding, follow-up bead candidate): the boundary
    // disclosure filter's PII_PATTERN includes `date of birth` / `DOB:`, but
    // claude-runtime's classifyContent PII set is EMAIL / PHONE / SSN only — no
    // DOB — so a DOB-only leak passes the policy pipeline (which gates on
    // classifyContent) and is caught only at the repository boundary. The two
    // PII vocabularies have drifted; the classifier is the weaker one. Surfaced
    // here, not hidden by loosening a rule.
    expectCaughtBy: ['boundary-disclosure'],
    knownFalseNegativeOf: ['policy-pipeline', 'content-classifier'],
  },
  {
    id: 'pii-inline-email-01',
    description: 'Email address inline (classifier flags PII; boundary filter does not)',
    sensitiveClass: 'pii',
    surface: 'inline',
    candidate: { content: 'Reach the on-call at jane.doe@internal-corp.example for escalations.' },
    // classifyContent's PII_PATTERNS include email → confidential. The boundary
    // filter's PII_PATTERN is SSN/DOB/background-check only (email is often
    // legitimate), so it does NOT flag — documented divergence, not a bug.
    expectCaughtBy: ['policy-pipeline', 'content-classifier'],
    knownFalseNegativeOf: ['boundary-disclosure'],
  },

  /* -------------- PII / secrets hidden in ODD metadata fields ------------- */
  {
    id: 'pii-filepath-ssn-01',
    description: 'SSN smuggled into metadata.filePaths (an odd field)',
    sensitiveClass: 'pii',
    surface: 'metadata-filepath',
    candidate: {
      content: 'A perfectly ordinary architecture note about the intake service.',
      metadata: { filePaths: [`/records/patient-${SSN_SHAPE}.txt`], tags: [] },
    },
    // The R10 target: the boundary filter WOULD catch this string — but only if
    // the API intake scanner is extended to pass filePaths (this PR's fix). The
    // policy pipeline scans candidate.content only, so it never sees filePaths.
    expectCaughtBy: ['boundary-disclosure'],
    knownFalseNegativeOf: ['policy-pipeline', 'secret-scanner', 'content-classifier'],
  },
  {
    id: 'sec-filepath-aws-01',
    description: 'AWS key smuggled into metadata.filePaths',
    sensitiveClass: 'secret',
    surface: 'metadata-filepath',
    candidate: {
      content: 'Ordinary note about the deploy pipeline layout.',
      metadata: { filePaths: [`/keys/${AWS_EXAMPLE_KEY}.pem`], tags: [] },
    },
    expectCaughtBy: ['boundary-disclosure'],
    knownFalseNegativeOf: ['policy-pipeline', 'secret-scanner', 'content-classifier'],
  },
  {
    id: 'pii-projectcontext-ssn-01',
    description: 'SSN smuggled into metadata.projectContext',
    sensitiveClass: 'pii',
    surface: 'metadata-projectcontext',
    candidate: {
      content: 'Note about the payroll importer.',
      metadata: { filePaths: [], tags: [], projectContext: `onboarding for SSN ${SSN_SHAPE}` },
    },
    expectCaughtBy: ['boundary-disclosure'],
    knownFalseNegativeOf: ['policy-pipeline', 'secret-scanner', 'content-classifier'],
  },

  /* --------------------- internal-path leaks (flag) ----------------------- */
  {
    id: 'path-unix-home-01',
    description: 'Unix /home/<user>/ path leaked inline (content_sanitization flags)',
    sensitiveClass: 'internal-path',
    surface: 'inline',
    candidate: { content: 'The log is at /home/jeremy/.teamkb/audit/anchors.jsonl on the box.' },
    // classifyContent marks internal → not restricted; content_sanitization
    // FLAGS (does not reject). We score the classifier catching "internal".
    expectCaughtBy: ['content-classifier'],
  },
  {
    id: 'path-macos-01',
    description: 'macOS /Users/<user>/ path leaked inline',
    sensitiveClass: 'internal-path',
    surface: 'inline',
    candidate: { content: 'Built from /Users/alice/dev/secret-project/main.ts locally.' },
    expectCaughtBy: ['content-classifier'],
  },
  {
    id: 'path-windows-01',
    description: 'Windows absolute path leaked inline',
    sensitiveClass: 'internal-path',
    surface: 'inline',
    candidate: { content: 'Output written to C:\\Users\\bob\\build\\artifact.exe on the runner.' },
    expectCaughtBy: ['content-classifier'],
  },

  /* --------------------- tenancy / author spoofing ------------------------ */
  {
    id: 'spoof-tenant-secret-01',
    description:
      'Attacker sets tenantId to a different tenant AND hides a key there (tenancy-guard evasion + leak)',
    sensitiveClass: 'secret',
    surface: 'tenant-spoof',
    candidate: {
      content: 'Routine note.',
      tenantId: `victim-tenant ${OPENAI_SHAPE}`,
    },
    // The boundary filter (structural walk in assertDisclosureClean) scans
    // tenantId and catches the key; the intake early-check and the policy
    // pipeline (content-only) do NOT — documented, and the reason R9/R10 both
    // gate the public ship.
    expectCaughtBy: ['boundary-disclosure'],
    knownFalseNegativeOf: ['policy-pipeline', 'secret-scanner', 'content-classifier'],
  },

  /* ---------------------------- NEGATIVES --------------------------------- */
  {
    id: 'neg-mentions-password-01',
    description: 'Prose that merely MENTIONS the word "password" (must NOT fire)',
    sensitiveClass: 'none',
    surface: 'benign',
    candidate: {
      content: 'Always hash the password with a slow KDF; never store it in plaintext.',
    },
    expectCaughtBy: [],
  },
  {
    id: 'neg-mentions-secret-01',
    description: 'Prose mentioning "secret" / "token" as concepts (must NOT fire)',
    sensitiveClass: 'none',
    surface: 'benign',
    candidate: {
      content: 'Rotate the API token quarterly and keep the secret out of the repo.',
    },
    expectCaughtBy: [],
  },
  {
    id: 'neg-code-snippet-01',
    description: 'Ordinary TypeScript with no credentials (must NOT fire)',
    sensitiveClass: 'none',
    surface: 'benign',
    candidate: {
      content: 'export function add(a: number, b: number): number {\n  return a + b;\n}',
    },
    expectCaughtBy: [],
  },
  {
    id: 'neg-semver-01',
    description: 'A semver-looking string (not a secret; must NOT fire)',
    sensitiveClass: 'none',
    surface: 'benign',
    candidate: { content: 'Upgraded the kernel package to version 1.2.3 in this release.' },
    expectCaughtBy: [],
  },
  {
    id: 'neg-short-hex-01',
    description: 'A short git SHA (7 hex) — below the high-entropy-hex threshold (must NOT fire)',
    sensitiveClass: 'none',
    surface: 'benign',
    candidate: { content: 'Fixed in commit 1a2b3c4 on the main branch.' },
    expectCaughtBy: [],
  },
  {
    id: 'neg-uuid-in-prose-01',
    description:
      'A UUID used as an id in prose (heroku-key regex is UUID-shaped — precision guard)',
    sensitiveClass: 'none',
    surface: 'benign',
    candidate: {
      content: 'The request id was 3f2504e0-4f89-41d3-9a0c-0305e82c3301 in the trace.',
    },
    // NOTE: this is a deliberate PRECISION probe. The heroku-api-key rule is a
    // bare UUID regex, so classify/secret-scanner treat any UUID as a secret.
    // We expect NO check to fire; if one does it is a FALSE POSITIVE and drags
    // that check's precision — surfaced, not hidden. (Documented in README.)
    expectCaughtBy: [],
  },
  {
    id: 'neg-ratio-technical-01',
    description: 'A 60/40 traffic split in technical context (boundary comp-gate must NOT fire)',
    sensitiveClass: 'none',
    surface: 'benign',
    candidate: { content: 'We route a 60/40 traffic split between the two regions.' },
    expectCaughtBy: [],
  },
  {
    id: 'neg-plain-note-01',
    description: 'A plain architecture note (must NOT fire)',
    sensitiveClass: 'none',
    surface: 'benign',
    candidate: {
      content: 'The compiler keeps raw and derived content strictly separate with provenance.',
    },
    expectCaughtBy: [],
  },
  {
    id: 'neg-relative-path-01',
    description: 'A relative repo path (not an internal absolute path; must NOT fire)',
    sensitiveClass: 'none',
    surface: 'benign',
    candidate: { content: 'See packages/policy-engine/src/pipeline.ts for the evaluate loop.' },
    expectCaughtBy: [],
  },
  {
    id: 'neg-benign-filepath-01',
    description: 'A clean relative path in metadata.filePaths (odd-field precision guard)',
    sensitiveClass: 'none',
    surface: 'benign',
    candidate: {
      content: 'A note about the store layer.',
      metadata: { filePaths: ['packages/store/src/repositories/policy-repository.ts'], tags: [] },
    },
    expectCaughtBy: [],
  },
];

/**
 * Default candidate scaffold that every case is merged over, so each case is a
 * complete Zod-valid `MemoryCandidate`. Deliberately benign — a case only turns
 * "positive" by overriding a field with sensitive material.
 */
export const CASE_DEFAULTS = {
  status: 'inbox' as const,
  source: 'claude_session' as const,
  title: 'govern-eval fixture',
  category: 'reference' as const,
  trustLevel: 'medium' as const,
  author: { type: 'ai' as const, id: 'govern-eval' },
  tenantId: 'govern-eval-tenant',
  metadata: { filePaths: [], tags: [] },
  prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
  capturedAt: '2026-06-30T00:00:00.000Z',
};
