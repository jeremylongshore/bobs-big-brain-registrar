import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/http-parser-contract.mjs');
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'http-parser-security-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('actual SDK-resolved HTTP parser dependency (not a stdio transport cap)', () => {
  it.each(['app', 'qmd'])(
    'keeps the %s SDK parser process alive after compressed trailing bytes',
    (instance) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(TEAMKB_|QMD_)/.test(key) && key !== 'INDEX_PATH',
        ),
      );
      const output = execFileSync(process.execPath, [fixture, instance], {
        cwd: scratch,
        env,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(JSON.parse(output)).toMatchObject({
        trailingFrameSurvives: true,
        validGzip: true,
        malformedRefused: true,
        subsequentRequestAlive: true,
      });
    },
    15_000,
  );
  it('survives excessive content encodings through testcontainers’ actual undici instance', () => {
    const output = execFileSync(
      process.execPath,
      [join(dirname(fixture), 'undici-content-encoding-contract.mjs')],
      {
        cwd: scratch,
        env: process.env,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(JSON.parse(output)).toMatchObject({
      excessiveEncodingsRefused: true,
      subsequentRequestAlive: true,
    });
  }, 15_000);
});
