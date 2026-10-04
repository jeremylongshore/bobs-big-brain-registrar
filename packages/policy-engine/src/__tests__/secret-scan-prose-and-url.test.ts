/**
 * Fixture table for the two value-bearing secret patterns added for umbrella
 * bead compile-then-govern-39z.17: `prose-password` and
 * `url-embedded-credentials`.
 *
 * Every value below is SYNTHETIC — invented for this file, never a live
 * credential. The table is the precision/recall evidence for the patterns: the
 * last block computes both over the whole table and pins them at 1.0.
 */
import { describe, it, expect } from 'vitest';
import { evaluateSecretDetection } from '../rules/secret-detection-rule.js';
import { scanTextForSecrets } from '../secret-scan.js';
import { makeCandidate, makeContext } from './fixtures.js';

const PROSE = 'prose-password';
const URL_CREDS = 'url-embedded-credentials';
const NEW_PATTERNS = [PROSE, URL_CREDS] as const;

interface Fixture {
  name: string;
  content: string;
  /** Which of the two new patterns must fire. Empty = must stay silent. */
  expected: readonly (typeof NEW_PATTERNS)[number][];
}

const POSITIVE: Fixture[] = [
  {
    name: 'the incident shape: sudo password for the migration, backticked',
    content: 'The sudo password for the migration is `Tq7!vexLorn42`.',
    expected: [PROSE],
  },
  {
    name: 'the incident shape: recommended sudo password for a user, backticked',
    content: 'For now the recommended sudo password for deploybot is `zK4#plumWidget9`',
    expected: [PROSE],
  },
  {
    name: 'user name itself backticked before the value',
    content: 'the password for `deploybot` is `Wm2$harborKite`',
    expected: [PROSE],
  },
  {
    name: 'past tense, double-quoted',
    content: 'The old root password was "Nf8&cinderMoth" until the rebuild.',
    expected: [PROSE],
  },
  {
    name: 'colon form, single-quoted',
    content: "admin password: 'Rb5^tallowFinch'",
    expected: [PROSE],
  },
  {
    name: 'equals form in code, double-quoted',
    content: 'const password = "Hd3@quartzLoom";',
    expected: [PROSE],
  },
  {
    name: 'JSON key/value',
    content: '{ "user": "svc", "password": "Lp6*emberVane" }',
    expected: [PROSE],
  },
  {
    name: 'passphrase keyword',
    content: 'The backup passphrase is `Yc9-oatFieldDrum`',
    expected: [PROSE],
  },
  {
    name: 'passwd keyword with "is:"',
    content: 'the passwd is: `Gs1+nettleCairn`',
    expected: [PROSE],
  },
  {
    name: 'bold markdown around the backticked value',
    content: 'The wifi password is **`Vx4=larchSpindle`**',
    expected: [PROSE],
  },
  {
    name: 'sentence split across a newline before the value',
    content: 'The sudo password for the migration is\n`Jt8!marlinQuoin` and it expires Friday.',
    expected: [PROSE],
  },
  {
    name: 'a placeholder earlier on the line does not hide a real value later',
    content: 'password is `<your password>`, e.g. the staging password is `Ku2#fennelRook`',
    expected: [PROSE],
  },
  {
    name: 'weak-but-real numeric value',
    content: 'the door password is `48213907`',
    expected: [PROSE],
  },
  {
    name: 'connection string with a non-standard scheme',
    content: 'engine = create("dialect+driver://svc_app:Pz7mossHalyard@db.internal:5432/app")',
    expected: [URL_CREDS],
  },
  {
    name: 'https basic-auth URL',
    content: 'curl https://deploy:Fq3tinderWren@registry.internal/v2/',
    expected: [URL_CREDS],
  },
  {
    name: 'empty user (redis style)',
    content: 'REDIS_URL is rediss://:Dn5cobaltThrush@cache.internal:6380',
    expected: [URL_CREDS],
  },
  {
    name: 'amqp URL in prose',
    content: 'The broker lives at amqps://worker:Sb9juniperLatch@mq.internal/vhost today.',
    expected: [URL_CREDS],
  },
  {
    name: 'placeholder URL first, real URL later on the same line',
    content:
      'format scheme://username:password@host — ours is sftp://ops:Ew6saffronGable@files.internal',
    expected: [URL_CREDS],
  },
];

const NEGATIVE: Fixture[] = [
  {
    name: 'the live false positive: documentation placeholder connection string',
    content: 'SQLAlchemy URLs look like dialect+driver://username:password@host:port/database',
    expected: [],
  },
  {
    name: 'user:pass placeholder',
    content: 'postgres://user:pass@localhost:5432/db',
    expected: [],
  },
  { name: 'pwd placeholder', content: 'ftp://admin:pwd@files.example.com', expected: [] },
  { name: 'secret placeholder', content: 'amqp://guest:secret@broker:5672', expected: [] },
  { name: 'changeme placeholder', content: 'mongodb://root:changeme@mongo:27017', expected: [] },
  { name: 'example placeholder', content: 'https://alice:example123@host.test/', expected: [] },
  { name: 'xxx placeholder', content: 'https://deploy:xxxxxxxx@registry.internal/', expected: [] },
  {
    name: 'angle-bracket template',
    content: 'mysql://<user>:<password>@<host>:3306/<db>',
    expected: [],
  },
  {
    name: 'shell variable template',
    content: 'postgres://app:${PGPASSWORD}@db.internal:5432/app',
    expected: [],
  },
  { name: 'bare $VAR', content: 'https://ci:$REGISTRY_TOKEN@registry.internal/', expected: [] },
  { name: 'brace template', content: 'redis://{user}:{password}@{host}:6379', expected: [] },
  { name: 'your-password', content: 'smtp://mailer:your-password@smtp.internal', expected: [] },
  {
    name: 'PASSWORD upper-case literal',
    content: 'ldap://cn=admin:PASSWORD@ldap.internal',
    expected: [],
  },
  {
    name: 'URL with a port and a path, no credentials',
    content: 'http://localhost:8080/health',
    expected: [],
  },
  {
    name: 'port followed by a query containing an email',
    content: 'http://localhost:3000?notify=ops@intent.test',
    expected: [],
  },
  {
    name: 'port followed by a path containing @',
    content: 'https://registry.internal:443/@scope/pkg',
    expected: [],
  },
  {
    name: 'ssh URL with a user and no password',
    content: 'ssh://git@github.com:22/owner/repo.git',
    expected: [],
  },
  { name: 'scp-style remote', content: 'git clone git@github.com:owner/repo.git', expected: [] },
  {
    name: 'docs: password: <your password>',
    content: 'Set these in the config:\n  username: <your user>\n  password: <your password>',
    expected: [],
  },
  { name: 'docs: quoted angle template', content: 'password: "<your-password>"', expected: [] },
  { name: 'env-var reference, shell', content: 'export PGPASSWORD="$DB_PASSWORD"', expected: [] },
  { name: 'env-var reference, template', content: 'password: "${VAULT_DB_PASS}"', expected: [] },
  {
    name: 'env-var reference, code',
    content: 'const password = process.env["DB_PASSWORD"];',
    expected: [],
  },
  { name: 'env-var NAME as the value', content: 'the password is `SUDO_PASS_PROD`', expected: [] },
  {
    name: 'the word password with no value',
    content: 'The sudo password for the migration is stored in SOPS, never in the brain.',
    expected: [],
  },
  {
    name: 'password mentioned, value absent',
    content: 'Rotate the password after every incident.',
    expected: [],
  },
  {
    name: 'quoted phrase, not a password',
    content: 'The password is "not stored anywhere on disk".',
    expected: [],
  },
  {
    name: 'multi-line quoted phrase must not be glued into a token',
    content: 'Notes:\npassword: "Kept In The Vault 2"\nend',
    expected: [],
  },
  {
    name: 'file path as the value',
    content: 'the password is in SOPS; the file is `~/.pgpass`',
    expected: [],
  },
  {
    name: 'file name as the value',
    content: 'password store is `secrets.prod.sops.yaml`',
    expected: [],
  },
  { name: 'status word as the value', content: 'password auth is `enabled`', expected: [] },
  {
    name: 'placeholder word as the value',
    content: 'the default password is "changeme"',
    expected: [],
  },
  { name: 'value shorter than 6 characters', content: 'password is `abc12`', expected: [] },
  { name: 'JSON schema type, not a value', content: '{ "password": "string" }', expected: [] },
  { name: 'masked value', content: 'the password is `********`', expected: [] },
  {
    name: 'unrelated quoted value far from the keyword',
    content:
      'Passwords are managed centrally by the platform team and rotated quarterly; the service name is `billing-gateway`',
    expected: [],
  },
];

function firedNewPatterns(content: string): string[] {
  return scanTextForSecrets(content)
    .map((f) => f.patternId)
    .filter((id): id is (typeof NEW_PATTERNS)[number] =>
      (NEW_PATTERNS as readonly string[]).includes(id),
    );
}

describe('prose-password / url-embedded-credentials — positive fixtures', () => {
  it.each(POSITIVE)('flags: $name', ({ content, expected }) => {
    expect(firedNewPatterns(content)).toEqual([...expected].sort());
  });
});

describe('prose-password / url-embedded-credentials — negative fixtures', () => {
  it.each(NEGATIVE)('stays silent: $name', ({ content }) => {
    expect(firedNewPatterns(content)).toEqual([]);
  });
});

describe('prose-password / url-embedded-credentials — fixture precision and recall', () => {
  it('scores precision 1.0 and recall 1.0 over the whole table', () => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const fixture of [...POSITIVE, ...NEGATIVE]) {
      const fired = new Set(firedNewPatterns(fixture.content));
      for (const pattern of NEW_PATTERNS) {
        const want = fixture.expected.includes(pattern);
        const got = fired.has(pattern);
        if (want && got) truePositives += 1;
        if (!want && got) falsePositives += 1;
        if (want && !got) falseNegatives += 1;
      }
    }
    expect(POSITIVE).toHaveLength(18);
    expect(NEGATIVE).toHaveLength(36);
    expect({ truePositives, falsePositives, falseNegatives }).toEqual({
      truePositives: 18,
      falsePositives: 0,
      falseNegatives: 0,
    });
    expect(truePositives / (truePositives + falsePositives)).toBe(1);
    expect(truePositives / (truePositives + falseNegatives)).toBe(1);
  });
});

describe('secret_detection rule — never echoes the matched value', () => {
  const rule = {
    id: 'rule-secret-detection',
    type: 'secret_detection' as const,
    action: 'reject' as const,
    enabled: true,
    priority: 0,
    parameters: {},
  };

  it('rejects the incident shape and names the pattern and line, not the value', () => {
    const content = [
      'Migration runbook.',
      'Step 2: The sudo password for the migration is `Tq7!vexLorn42`.',
    ].join('\n');
    const candidate = makeCandidate({ content });
    const result = evaluateSecretDetection(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain('Password Stated in Prose');
    expect(result.reason).toContain('prose-password at line 2');
    expect(result.reason).not.toContain('Tq7!vexLorn42');
  });

  it('rejects an embedded-credential URL without echoing user or secret', () => {
    const content = 'engine = "dialect+driver://svc_app:Pz7mossHalyard@db.internal:5432/app"';
    const candidate = makeCandidate({ content });
    const result = evaluateSecretDetection(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('fail');
    expect(result.reason).toContain('url-embedded-credentials at line 1');
    expect(result.reason).not.toContain('Pz7mossHalyard');
    expect(result.reason).not.toContain('svc_app');
  });

  it('passes the documentation placeholder connection string', () => {
    const content =
      'SQLAlchemy URLs look like dialect+driver://username:password@host:port/database';
    const candidate = makeCandidate({ content });
    const result = evaluateSecretDetection(candidate, rule, makeContext(candidate));
    expect(result.outcome).toBe('pass');
  });

  it('no fixture leaks its value into a finding', () => {
    for (const fixture of POSITIVE) {
      // A finding carries pattern id, name and line numbers only.
      for (const finding of scanTextForSecrets(fixture.content)) {
        expect(Object.keys(finding).sort()).toEqual(['lines', 'patternId', 'patternName']);
      }
    }
  });
});

describe('scanTextForSecrets', () => {
  it('returns one finding per pattern with every line it fired on, sorted', () => {
    const content = [
      'the password is `Tq7!vexLorn42`',
      'nothing here',
      'the passphrase is `Yc9-oatFieldDrum`',
    ].join('\n');
    const prose = scanTextForSecrets(content).filter((f) => f.patternId === PROSE);
    expect(prose).toEqual([
      { patternId: PROSE, patternName: 'Password Stated in Prose', lines: [1, 3] },
    ]);
  });

  it('sorts findings by pattern id', () => {
    const content =
      'the password is `Tq7!vexLorn42` and https://deploy:Fq3tinderWren@registry.internal/';
    const ids = scanTextForSecrets(content).map((f) => f.patternId);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(ids).toContain(PROSE);
    expect(ids).toContain(URL_CREDS);
  });

  it('returns an empty list for clean text', () => {
    expect(scanTextForSecrets('Use Result<T, E> for fallible operations.')).toEqual([]);
  });
});
