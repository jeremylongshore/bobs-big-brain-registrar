/**
 * Hand-labeled fixture for the `audience_narrowing` rule (Epic K bead K3, KR8.2).
 *
 * Each case is labeled by a human reading the content, NOT by running the rule:
 * `shouldNarrow` answers "is the declared audience wider than this content
 * calls for?" and `expected` names the tier a careful reviewer would choose.
 * The rule's precision and recall are measured against these labels on their
 * own and are never blended into the disclosure (secret / PII) metrics.
 *
 * Every secret-shaped value is synthetic and assembled from parts, so no
 * literal credential-shaped string sits in the source. Cases marked `knownGap`
 * are labeled honestly even though the current patterns get them wrong; they
 * are counted in the metrics, not excluded.
 */
export interface LabeledAudienceCase {
  id: string;
  content: string;
  /** Declared audience; undefined = the tenant-wide default. */
  declared?: 'tenant' | 'admins' | 'owner';
  /** Human label: the declared audience is wider than the content calls for. */
  shouldNarrow: boolean;
  /** Human label: the tier the content calls for. */
  expected: 'tenant' | 'admins' | 'owner';
  /** A case the current deterministic patterns are known to get wrong. */
  knownGap?: string;
}

const AWS_KEY = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';
const GH_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(2);
const SLACK_TOKEN = 'xoxb-' + '1234567890' + '-abcdefghij';
const JWT = [
  'eyJ' + 'hbGciOiJIUzI1NiJ9',
  'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0',
  'SflKxwRJSMeKKF2QT4fw',
].join('.');
const PG_URL = 'postgres://svc_reader:' + 'Tr0ub4dor-and-3' + '@db.internal.example:5432/app';
const ENV_SECRET = 'DEPLOY_' + 'PASSWORD=' + 'correct-horse-battery';
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const GIT_SHA = '9f2c4e1a7b3d5f6089a1b2c3d4e5f60718293a4b';

export const AUDIENCE_NARROWING_CASES: readonly LabeledAudienceCase[] = [
  // --- Positives: the declared audience IS wider than the content calls for ---
  {
    id: 'pos-aws-key-tenant',
    content: `The staging uploader authenticates with access key ${AWS_KEY} against the media bucket.`,
    declared: 'tenant',
    shouldNarrow: true,
    expected: 'owner',
  },
  {
    id: 'pos-github-token-default',
    content: `CI pushes release tags using the token ${GH_TOKEN} stored on the runner.`,
    shouldNarrow: true,
    expected: 'owner',
  },
  {
    id: 'pos-connection-string-admins',
    content: `The reporting job connects with ${PG_URL} every night at two.`,
    declared: 'admins',
    shouldNarrow: true,
    expected: 'owner',
  },
  {
    id: 'pos-env-secret-default',
    content: `The deploy script exports ${ENV_SECRET} before calling the release step.`,
    shouldNarrow: true,
    expected: 'owner',
  },
  {
    id: 'pos-pem-header-admins',
    content: `The signing key file starts with ${PEM} and lives beside the release script.`,
    declared: 'admins',
    shouldNarrow: true,
    expected: 'owner',
  },
  {
    id: 'pos-jwt-tenant',
    content: `For local testing paste the session token ${JWT} into the Authorization header.`,
    declared: 'tenant',
    shouldNarrow: true,
    expected: 'owner',
  },
  {
    id: 'pos-slack-token-tenant',
    content: `The alert bot posts with ${SLACK_TOKEN} to the incidents channel.`,
    declared: 'tenant',
    shouldNarrow: true,
    expected: 'owner',
  },
  {
    id: 'pos-personal-email-tenant',
    content:
      'Escalate billing disputes to dana.whitfield@customer-example.com, she owns the account.',
    declared: 'tenant',
    shouldNarrow: true,
    expected: 'admins',
  },
  {
    id: 'pos-phone-default',
    content: 'The on-call contractor can be reached at (251) 555-0143 after hours.',
    shouldNarrow: true,
    expected: 'admins',
  },
  {
    id: 'pos-ssn-shape-tenant',
    content: 'The new hire paperwork lists 078-05-1120 on the tax form we scanned.',
    declared: 'tenant',
    shouldNarrow: true,
    expected: 'admins',
  },
  {
    id: 'pos-date-of-birth-default',
    content: 'Her onboarding record gives a date of birth in March and a start date in June.',
    shouldNarrow: true,
    expected: 'admins',
  },
  {
    id: 'pos-background-check-tenant',
    content: 'The background check report came back clear, so the offer went out Friday.',
    declared: 'tenant',
    shouldNarrow: true,
    expected: 'admins',
  },
  {
    id: 'pos-prose-password-tenant',
    content: 'The sudo password for the migration box is `Winter-Harbor-42x` until Friday.',
    declared: 'tenant',
    shouldNarrow: true,
    expected: 'owner',
  },
  {
    id: 'pos-compensation-tenant',
    content: 'We agreed her base moves to one hundred forty thousand with a ten percent bonus.',
    declared: 'tenant',
    shouldNarrow: true,
    expected: 'admins',
    knownGap: 'compensation stated in words is not a classifier pattern',
  },

  // --- Negatives: the declared audience is NOT wider than the content calls for ---
  {
    id: 'neg-plain-convention',
    content:
      'Use Result types for every fallible operation; never throw across a package boundary.',
    declared: 'tenant',
    shouldNarrow: false,
    expected: 'tenant',
  },
  {
    id: 'neg-plain-default',
    content: 'The exporter writes one Markdown file per memory, routed by category.',
    shouldNarrow: false,
    expected: 'tenant',
  },
  {
    id: 'neg-aws-key-already-owner',
    content: `The staging uploader authenticates with access key ${AWS_KEY} against the media bucket.`,
    declared: 'owner',
    shouldNarrow: false,
    expected: 'owner',
  },
  {
    id: 'neg-email-already-admins',
    content:
      'Escalate billing disputes to dana.whitfield@customer-example.com, she owns the account.',
    declared: 'admins',
    shouldNarrow: false,
    expected: 'admins',
  },
  {
    id: 'neg-email-already-owner',
    content:
      'Escalate billing disputes to dana.whitfield@customer-example.com, she owns the account.',
    declared: 'owner',
    shouldNarrow: false,
    expected: 'admins',
  },
  {
    id: 'neg-phone-already-admins',
    content: 'The on-call contractor can be reached at (251) 555-0143 after hours.',
    declared: 'admins',
    shouldNarrow: false,
    expected: 'admins',
  },
  {
    id: 'neg-uuid-in-prose',
    content:
      'Request 3f2504e0-4f89-41d3-9a0c-0305e82c3301 timed out twice before the retry landed.',
    declared: 'tenant',
    shouldNarrow: false,
    expected: 'tenant',
  },
  {
    id: 'neg-password-word-no-value',
    content: 'Password rotation happens quarterly and is tracked in the security calendar.',
    declared: 'tenant',
    shouldNarrow: false,
    expected: 'tenant',
  },
  {
    id: 'neg-internal-path-only',
    content: 'The build cache lives under /home/builder/.cache/pnpm and is safe to clear.',
    declared: 'tenant',
    shouldNarrow: false,
    expected: 'tenant',
  },
  {
    id: 'neg-token-prefix-described',
    content: 'GitHub personal tokens start with a short ghp prefix followed by a long random body.',
    declared: 'tenant',
    shouldNarrow: false,
    expected: 'tenant',
  },
  {
    id: 'neg-clean-decision-admins',
    content:
      'We decided to keep one shared export tree per tenant until per-audience indexes exist.',
    declared: 'admins',
    shouldNarrow: false,
    expected: 'tenant',
  },
  {
    id: 'neg-clean-owner',
    content: 'Renewal terms are reviewed each spring before the contract auto-extends.',
    declared: 'owner',
    shouldNarrow: false,
    expected: 'tenant',
  },
  {
    id: 'neg-ten-digit-build-number',
    content: 'Build 2026100412 finished in nine minutes and published the artifacts.',
    declared: 'tenant',
    shouldNarrow: false,
    expected: 'tenant',
    knownGap: 'any ten consecutive digits match the phone-number pattern',
  },
  {
    id: 'neg-git-sha',
    content: `The fix landed in commit ${GIT_SHA} and was deployed the same afternoon.`,
    declared: 'tenant',
    shouldNarrow: false,
    expected: 'tenant',
    knownGap: 'a 40-character commit hash matches the high-entropy-hex credential pattern',
  },
  {
    id: 'neg-placeholder-connection-string',
    content:
      'Set DATABASE_URL to postgres://user:password@localhost:5432/app in the example env file.',
    declared: 'tenant',
    shouldNarrow: false,
    expected: 'tenant',
    knownGap: 'a documentation placeholder matches the connection-string pattern',
  },
];
