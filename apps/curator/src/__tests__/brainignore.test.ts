/**
 * Tests for the brainignore ruleset engine + loader (bead 5kw.1): pattern
 * compilation, gitignore-style matching (last match wins, `!` negation),
 * the committed defaults against the 2026-07-16 junk classes, the content
 * heuristics, and the override-file loader.
 *
 * @module __tests__/brainignore.test
 */

import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BRAINIGNORE_RULESET,
  analyzeContent,
  compilePattern,
  matchPath,
  parseBrainignore,
  shannonEntropy,
  type BrainignoreRuleset,
} from '../import-exclusion/brainignore.js';
import { loadBrainignoreRuleset } from '../import-exclusion/load-brainignore.js';

function rulesetOf(...patterns: string[]): BrainignoreRuleset {
  return { patterns: parseBrainignore(patterns.join('\n'), 'override'), overridePath: null };
}

describe('compilePattern', () => {
  it('returns null for blank lines and comments', () => {
    expect(compilePattern('', 'default')).toBeNull();
    expect(compilePattern('   ', 'default')).toBeNull();
    expect(compilePattern('# a comment', 'default')).toBeNull();
    expect(compilePattern('!', 'default')).toBeNull();
  });

  it('parses negation and records provenance', () => {
    const p = compilePattern('!**/node_modules/keep-me/**', 'override');
    expect(p).not.toBeNull();
    expect(p!.negated).toBe(true);
    expect(p!.source).toBe('override');
    expect(p!.pattern).toBe('**/node_modules/keep-me/**');
  });

  it('escapes regex metacharacters literally', () => {
    const rs = rulesetOf('package-lock.json');
    // The dot must not match "any char".
    expect(matchPath('a/package-lockxjson', rs)).toBeNull();
    expect(matchPath('a/package-lock.json', rs)).not.toBeNull();
  });
});

describe('matchPath', () => {
  it('basename patterns (no slash) match the final segment anywhere', () => {
    const rs = rulesetOf('yarn.lock');
    expect(matchPath('yarn.lock', rs)).not.toBeNull();
    expect(matchPath('deep/nested/dir/yarn.lock', rs)).not.toBeNull();
    expect(matchPath('deep/yarn.lock/readme.md', rs)).toBeNull();
  });

  it('`*` does not cross a slash; `**` does', () => {
    const single = rulesetOf('docs/*.md');
    expect(matchPath('docs/a.md', single)).not.toBeNull();
    expect(matchPath('docs/sub/a.md', single)).toBeNull();
    const double = rulesetOf('docs/**');
    expect(matchPath('docs/sub/a.md', double)).not.toBeNull();
  });

  it('`**/x` also matches x at the path root (gitignore semantics)', () => {
    const rs = rulesetOf('**/node_modules/**');
    expect(matchPath('node_modules/pkg/README.md', rs)).not.toBeNull();
    expect(matchPath('a/b/node_modules/pkg/README.md', rs)).not.toBeNull();
  });

  it('matching is case-insensitive (documented deviation from gitignore)', () => {
    const rs = rulesetOf('LICENSE*');
    expect(matchPath('vendor-pkg/license.txt', rs)).not.toBeNull();
    expect(matchPath('vendor-pkg/License', rs)).not.toBeNull();
  });

  it('normalizes backslashes and leading ./', () => {
    const rs = rulesetOf('**/node_modules/**');
    expect(matchPath('./a/node_modules/x.md', rs)).not.toBeNull();
    expect(matchPath('a\\node_modules\\x.md', rs)).not.toBeNull();
  });

  it('last match wins: a later !pattern re-includes an earlier exclusion', () => {
    const rs = rulesetOf('**/node_modules/**', '!**/node_modules/my-own-pkg/**');
    expect(matchPath('node_modules/other/README.md', rs)).not.toBeNull();
    expect(matchPath('node_modules/my-own-pkg/NOTES.md', rs)).toBeNull();
  });

  it('the committed defaults exclude the 2026-07-16 junk path classes', () => {
    const rs = DEFAULT_BRAINIGNORE_RULESET;
    for (const junkPath of [
      'iams-gcp-resources/node_modules/@google-cloud/storage/README.md',
      'proj/.venv/lib/python3.12/site-packages/requests/README.md',
      'repo/vendor/some-lib/docs.md',
      'repo/pnpm-lock.yaml',
      'repo/package-lock.json',
      'repo/CODE_OF_CONDUCT.md',
      'repo/SECURITY.md',
      'repo/SUPPORT.md',
      'repo/LICENSE',
      'repo/dist/bundle.js',
      'app/static/main.min.js',
      'app/static/main.js.map',
      'repo/.github/ISSUE_TEMPLATE/bug.md',
    ]) {
      expect(matchPath(junkPath, rs), junkPath).not.toBeNull();
    }
  });

  it('the committed defaults do NOT exclude ordinary knowledge paths', () => {
    const rs = DEFAULT_BRAINIGNORE_RULESET;
    for (const goodPath of [
      'docs/architecture/overview.md',
      '000-docs/013-OD-STND-commit-conventions.md',
      'src/index.ts',
      'wiki/topics/deployment.md',
      'README.md',
      'CHANGELOG.md',
    ]) {
      expect(matchPath(goodPath, rs), goodPath).toBeNull();
    }
  });
});

describe('analyzeContent heuristics', () => {
  const prose =
    'This is an ordinary prose note about deployment conventions. It explains how the ' +
    'team ships services, which checks gate a release, and where the runbooks live. ' +
    'Nothing about it resembles minified or generated output in any way.';

  it('passes ordinary prose', () => {
    expect(analyzeContent(prose, 'Deployment conventions')).toBeNull();
  });

  it('rejects placeholder titles', () => {
    for (const title of ['Untitled', ' untitled document ', 'No Title']) {
      const match = analyzeContent(prose, title);
      expect(match?.code).toBe('brainignore_untitled_title');
    }
  });

  it('rejects license boilerplate by marker phrase in the head', () => {
    const license =
      'Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n\n' +
      'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n';
    const match = analyzeContent(license, 'Some vendored file');
    expect(match?.code).toBe('brainignore_license_boilerplate');
    expect(match?.evidence).toContain('apache license');

    const mit =
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software';
    expect(analyzeContent(mit, 'note')?.code).toBe('brainignore_license_boilerplate');
  });

  it('does not fire the license heuristic on a marker deep in the body', () => {
    const deep = prose + '\n'.repeat(3) + 'x'.repeat(700) + '\nApache License mention way down.';
    expect(analyzeContent(deep, 'Licensing discussion')).toBeNull();
  });

  it('rejects minified content (long line, almost no whitespace)', () => {
    const minified = 'a=1;b=(c||d).e(f);'.repeat(100); // one 1800-char line, zero whitespace
    const match = analyzeContent(minified, 'bundle');
    expect(match?.code).toBe('brainignore_minified_content');
    expect(match?.evidence).toContain('whitespace ratio');
  });

  it('does not reject a long UNWRAPPED prose paragraph (whitespace ratio stays high)', () => {
    const longProse = (prose + ' ').repeat(6).replace(/\n/g, ' '); // one ~1400-char line of prose
    expect(analyzeContent(longProse, 'Long unwrapped note')).toBeNull();
  });

  it('rejects high-entropy generated/encoded blobs', () => {
    // Pseudo-base64 soup: deterministic, high symbol diversity, > 1024 chars.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let blob = '';
    for (let i = 0; i < 2048; i++) {
      blob += alphabet[(i * 37 + (i % 53)) % alphabet.length];
      if (i % 60 === 59) blob += '\n'; // keep lines short so the minified check stays out
    }
    const match = analyzeContent(blob, 'sourcemap payload');
    expect(match?.code).toBe('brainignore_generated_content');
  });

  it('shannonEntropy is deterministic and behaves at the anchors', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBeCloseTo(1, 5);
    expect(shannonEntropy(prose)).toBeLessThan(5.2);
  });
});

describe('loadBrainignoreRuleset', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'brainignore-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns defaults-only when the override file is absent', () => {
    const rs = loadBrainignoreRuleset({ path: join(dir, 'does-not-exist') });
    expect(rs.overridePath).toBeNull();
    expect(rs.patterns.every((p) => p.source === 'default')).toBe(true);
    expect(matchPath('a/node_modules/x.md', rs)).not.toBeNull();
  });

  it('appends override patterns AFTER the defaults so operator negation wins', async () => {
    const overridePath = join(dir, 'brainignore');
    await writeFile(
      overridePath,
      '# operator overrides\n!**/node_modules/my-own-pkg/**\ninternal-junk/**\n',
      'utf8',
    );
    const rs = loadBrainignoreRuleset({ path: overridePath });
    expect(rs.overridePath).toBe(overridePath);
    // Default exclusion still applies…
    expect(matchPath('node_modules/other/README.md', rs)).not.toBeNull();
    // …the operator negation re-admits…
    expect(matchPath('node_modules/my-own-pkg/NOTES.md', rs)).toBeNull();
    // …and the operator's own exclusion applies.
    expect(matchPath('internal-junk/scratch.md', rs)).not.toBeNull();
  });

  it('an unreadable override warns and degrades to defaults-only (never throws)', async () => {
    const unreadable = join(dir, 'locked');
    await mkdir(unreadable); // reading a directory as a file fails with EISDIR
    await chmod(unreadable, 0o000);
    const warnings: string[] = [];
    const rs = loadBrainignoreRuleset({ path: unreadable, onWarn: (m) => warnings.push(m) });
    expect(rs.overridePath).toBeNull();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('continuing with the committed defaults');
    await chmod(unreadable, 0o755);
  });
});
