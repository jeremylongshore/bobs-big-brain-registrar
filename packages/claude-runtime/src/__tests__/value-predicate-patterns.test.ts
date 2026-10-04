/**
 * Value-predicate (`accept`) machinery + the two patterns that use it
 * (`prose-password`, `url-embedded-credentials`) — umbrella bead
 * compile-then-govern-39z.17. Every credential-looking value is SYNTHETIC.
 */
import { describe, it, expect } from 'vitest';
import { isPathLikeValue, isPlaceholderSecretValue } from '../secrets/placeholder.js';
import { redactSecrets } from '../secrets/redactor.js';
import { scanForSecrets } from '../secrets/secret-scanner.js';
import type { SecretPattern } from '../types.js';

describe('isPlaceholderSecretValue', () => {
  it.each([
    'password',
    'PASSWORD',
    'your-password',
    'my_password1',
    'passwd',
    'passphrase',
    'pass',
    'pwd',
    'secret',
    'your-secret',
    'changeme',
    'change-me',
    'change_me',
    'example123',
    'placeholder',
    '[REDACTED:env-secret]',
    'redacted',
    'xxx',
    'sk-XXXXXXXX',
    '********',
    '......',
    '<password>',
    '<your password>',
    '${DB_PASS}',
    '$DB_PASS',
    '{password}',
    '{{ vault_pass }}',
    '%s',
    'process.env.DB_PASS',
    'os.environ',
    'getenv("X")',
    'secrets.DB_PASS',
    'SUDO_PASS_PROD',
    'DB_PASS',
    'token',
    'my-token',
    'enabled',
    'string',
    '',
    '   ',
  ])('treats %j as a placeholder', (value) => {
    expect(isPlaceholderSecretValue(value)).toBe(true);
  });

  it.each([
    'Tq7!vexLorn42',
    'zK4#plumWidget9',
    'Pz7mossHalyard',
    '48213907',
    'admin',
    'root123',
    'test1234',
    'hunter2',
    'correcthorse',
    'ABCDEF',
    'Secretariat9', // contains "secret" but is not ONLY placeholder words
    'mytokenvalue',
  ])('treats %j as a real value', (value) => {
    expect(isPlaceholderSecretValue(value)).toBe(false);
  });
});

describe('isPathLikeValue', () => {
  it.each(['~/.pgpass', '/etc/app/creds', './creds', '../creds', 'creds.yaml', 'a.YML', 'x.env'])(
    'treats %j as a path or file',
    (value) => {
      expect(isPathLikeValue(value)).toBe(true);
    },
  );

  it.each(['Tq7!vexLorn42', 'a/b1Cd', 'yaml', 'v1.2.3x', '~tilde'])(
    'treats %j as not a path',
    (value) => {
      expect(isPathLikeValue(value)).toBe(false);
    },
  );
});

describe('scanForSecrets — value predicate (accept)', () => {
  const evenOnly: SecretPattern = {
    id: 'even-number',
    name: 'Even Number',
    regex: /N(\d)/,
    description: 'test pattern: N followed by a digit, accepted only when even',
    accept: (match) => Number(match[1]) % 2 === 0,
  };

  it('suppresses a match the predicate rejects', () => {
    expect(scanForSecrets('N1 N3 N5', [evenOnly])).toEqual([]);
  });

  it('reports the first ACCEPTED match, skipping earlier rejected ones', () => {
    const matches = scanForSecrets('N1 N3 N4 N6', [evenOnly]);
    expect(matches).toEqual([
      { patternId: 'even-number', patternName: 'Even Number', line: 1, column: 7, matchLength: 2 },
    ]);
  });

  it('is deterministic across repeated scans, including for a global-flag regex', () => {
    const globalEven: SecretPattern = { ...evenOnly, regex: /N(\d)/g };
    const first = scanForSecrets('N1 N4', [globalEven]);
    const second = scanForSecrets('N1 N4', [globalEven]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]!.column).toBe(4);
  });

  it('terminates on a pattern that can match the empty string', () => {
    const emptyCapable: SecretPattern = {
      id: 'empty-capable',
      name: 'Empty Capable',
      regex: /Z*/,
      description: 'test pattern: may match zero characters',
      accept: (match) => (match[0] ?? '').length >= 2,
    };
    const matches = scanForSecrets('aZbZZc', [emptyCapable]);
    expect(matches).toEqual([
      {
        patternId: 'empty-capable',
        patternName: 'Empty Capable',
        line: 1,
        column: 4,
        matchLength: 2,
      },
    ]);
    expect(scanForSecrets('abc', [emptyCapable])).toEqual([]);
  });

  it('still honours requiresContext on an accepted match', () => {
    const gated: SecretPattern = { ...evenOnly, requiresContext: /magic/ };
    expect(scanForSecrets('N4', [gated])).toEqual([]);
    expect(scanForSecrets('magic N4', [gated])).toHaveLength(1);
  });
});

describe('scanForSecrets — skipWhitespaceStrippedView', () => {
  const base: SecretPattern = {
    id: 'glued',
    name: 'Glued',
    regex: /ALPHABETA/,
    description: 'test pattern: only matches once whitespace is removed',
  };

  it('a normal pattern is matched in the whitespace-stripped view', () => {
    expect(scanForSecrets('ALPHA\nBETA', [base])).toHaveLength(1);
  });

  it('an opted-out pattern is NOT run against the whitespace-stripped view', () => {
    expect(scanForSecrets('ALPHA\nBETA', [{ ...base, skipWhitespaceStrippedView: true }])).toEqual(
      [],
    );
  });

  it('an opted-out pattern still runs against the single-space collapsed view', () => {
    const spaced: SecretPattern = {
      ...base,
      regex: /ALPHA BETA/,
      skipWhitespaceStrippedView: true,
    };
    expect(scanForSecrets('ALPHA\nBETA', [spaced])).toEqual([
      { patternId: 'glued', patternName: 'Glued', line: 1, column: 1, matchLength: 10 },
    ]);
  });
});

describe('scanForSecrets — prose-password and url-embedded-credentials (defaults)', () => {
  const ids = (content: string): string[] => scanForSecrets(content).map((m) => m.patternId);

  it('flags a prose password with its line and column, never the value', () => {
    const matches = scanForSecrets(
      'intro\nThe sudo password for the migration is `Tq7!vexLorn42`.',
    );
    const prose = matches.filter((m) => m.patternId === 'prose-password');
    expect(prose).toEqual([
      {
        patternId: 'prose-password',
        patternName: 'Password Stated in Prose',
        line: 2,
        column: 10,
        matchLength: 45,
      },
    ]);
    expect(JSON.stringify(matches)).not.toContain('Tq7!vexLorn42');
  });

  it('flags a prose password split across a newline (single-space view)', () => {
    expect(ids('The sudo password for the migration is\n`Jt8!marlinQuoin`')).toContain(
      'prose-password',
    );
  });

  it('does not glue a multi-line quoted phrase into a password', () => {
    expect(ids('Notes:\npassword: "Kept In The Vault 2"\nend')).not.toContain('prose-password');
  });

  it('respects the 40-character keyword window', () => {
    const near = `password ${'x'.repeat(30)} is \`Tq7!vexLorn42\``;
    const far = `password ${'y'.repeat(45)} is \`Tq7!vexLorn42\``;
    expect(ids(near)).toContain('prose-password');
    expect(ids(far)).not.toContain('prose-password');
  });

  it('respects the 6-character minimum and 128-character maximum value length', () => {
    expect(ids('password is `aB3!x`')).not.toContain('prose-password');
    expect(ids('password is `aB3!xy`')).toContain('prose-password');
    expect(ids(`password is \`${'aB3!'.repeat(32)}\``)).toContain('prose-password');
    expect(ids(`password is \`${'aB3!'.repeat(32)}q\``)).not.toContain('prose-password');
  });

  it('accepts curly quotes around the value', () => {
    expect(ids('the password is “Nf8&cinderMoth”')).toContain('prose-password');
    expect(ids('the password is ‘Nf8&cinderMoth’')).toContain('prose-password');
  });

  it('flags a URL with embedded credentials for an arbitrary scheme', () => {
    expect(ids('dialect+driver://svc_app:Pz7mossHalyard@db.internal:5432/app')).toContain(
      'url-embedded-credentials',
    );
  });

  it('does not flag the documentation placeholder URL', () => {
    expect(ids('dialect+driver://username:password@host:port/database')).toEqual([]);
  });

  it('does not treat a port as a password', () => {
    expect(ids('http://localhost:3000?notify=ops@intent.test')).not.toContain(
      'url-embedded-credentials',
    );
    expect(ids('https://registry.internal:443/@scope/pkg')).not.toContain(
      'url-embedded-credentials',
    );
    expect(ids('http://localhost:3000#frag@x')).not.toContain('url-embedded-credentials');
  });

  it('requires a secret of at least 3 characters and a host after the @', () => {
    expect(ids('ftp://ops:Zq@files.internal')).not.toContain('url-embedded-credentials');
    expect(ids('ftp://ops:Zq7@files.internal')).toContain('url-embedded-credentials');
    expect(ids('ftp://ops:Zq7mLw@ ')).not.toContain('url-embedded-credentials');
  });
});

describe('redactSecrets — value predicate agreement with the scanner', () => {
  it('redacts a prose password and leaves no trace of the value', () => {
    const result = redactSecrets('The sudo password for the migration is `Tq7!vexLorn42`.');
    expect(result).toBe('The sudo [REDACTED:prose-password].');
  });

  it('redacts embedded URL credentials for a non-standard scheme', () => {
    const result = redactSecrets('dialect+driver://svc_app:Pz7mossHalyard@db.internal:5432/app');
    expect(result).toContain('[REDACTED:url-embedded-credentials]');
    expect(result).not.toContain('Pz7mossHalyard');
  });

  it('leaves a documentation placeholder untouched (the scanner does not flag it)', () => {
    const doc = 'URLs look like dialect+driver://username:password@host:port/database';
    expect(redactSecrets(doc)).toBe(doc);
    const prose = 'the password is `<your password>` or "changeme"';
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('redacts only the accepted match when a placeholder shares the line', () => {
    const result = redactSecrets(
      'format scheme://username:password@host — ours is sftp://ops:Ew6saffronGable@files.internal',
    );
    expect(result).toContain('scheme://username:password@host');
    expect(result).not.toContain('Ew6saffronGable');
  });

  it('applies a custom predicate per match, including for a global-flag regex', () => {
    const evenOnly: SecretPattern = {
      id: 'even-number',
      name: 'Even Number',
      regex: /N(\d)/g,
      description: 'test pattern',
      accept: (match) => Number(match[1]) % 2 === 0,
    };
    expect(redactSecrets('N1 N2 N3 N4', [evenOnly])).toBe(
      'N1 [REDACTED:even-number] N3 [REDACTED:even-number]',
    );
  });

  it('still redacts every match of a predicate-free global-flag pattern', () => {
    const plain: SecretPattern = {
      id: 'plain',
      name: 'Plain',
      regex: /TOK\d/g,
      description: 'test pattern',
    };
    expect(redactSecrets('TOK1 TOK2', [plain])).toBe('[REDACTED:plain] [REDACTED:plain]');
  });
});
