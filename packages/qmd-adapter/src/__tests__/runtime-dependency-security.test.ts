import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/runtime-dependency-contract.mjs',
);
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runtime-security-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(mode: string, timeout = 15_000): unknown {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(GIT_|TEAMKB_|QMD_|SSH_)/i.test(key) && !/^(EDITOR|VISUAL|PAGER|INDEX_PATH)$/i.test(key),
    ),
  );
  const output = execFileSync(process.execPath, [fixture, mode, scratch], {
    cwd: scratch,
    env,
    encoding: 'utf8',
    timeout,
  });
  return JSON.parse(output);
}

describe('actual qmd runtime dependency contracts', () => {
  it('preserves node-llama’s real Git consumer operation and result shapes in owned repositories', () => {
    expect(run('git-normal')).toMatchObject({ consumerOperations: true, bundleVerified: true });
  }, 20_000);
  it('rejects executable trailer configuration before Git is spawned', () => {
    expect(run('git-trailer')).toMatchObject({ refusedBeforeSpawn: true, markerAbsent: true });
  }, 20_000);
  it('rejects an explicitly supplied VISUAL editor before Git is spawned', () => {
    expect(run('git-visual')).toMatchObject({ refusedBeforeSpawn: true, markerAbsent: true });
  }, 20_000);
  it('terminates negative-size non-secure nanoid generation and preserves normal IDs', () => {
    expect(run('nanoid', 3_000)).toMatchObject({ negativeSizesTerminate: true });
  }, 10_000);
  it('lists selected long-path tar members without stack overflow and extracts a valid control', () => {
    expect(run('tar')).toMatchObject({ selectedLongPathSurvives: true, validExtraction: true });
  }, 20_000);
});
