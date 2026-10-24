import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FIXTURE_QMD_BINARY,
  fixtureQmdArgs,
  fixtureQmdOptions,
  withFixtureQmdIndex,
} from '../qmd.js';

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'qmd-fixture-binding-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('test-only qmd command containment', () => {
  it('binds generated argv/environment despite synthetic ancestor and ambient overrides', () => {
    const childDir = join(scratch, 'ancestor', 'child');
    mkdirSync(childDir, { recursive: true });
    mkdirSync(join(scratch, 'ancestor', '.qmd'));
    const ancestor = join(scratch, 'ancestor', '.qmd', 'index.yaml');
    writeFileSync(ancestor, 'synthetic ancestor configuration must stay unused\n');
    const script = join(scratch, 'capture.cjs');
    writeFileSync(
      script,
      'console.log(JSON.stringify({args:process.argv.slice(2),index:process.env.INDEX_PATH,config:process.env.QMD_CONFIG_DIR,cache:process.env.XDG_CACHE_HOME}));',
    );
    const base = join(scratch, 'brain');
    const options = fixtureQmdOptions(base, 'fixture-tenant');
    const ambient: NodeJS.ProcessEnv = {
      ...process.env,
      INDEX_PATH: join(scratch, 'wrong-index'),
      QMD_CONFIG_DIR: join(scratch, 'wrong-config'),
      XDG_CACHE_HOME: join(scratch, 'wrong-cache'),
    };
    const output = execFileSync(
      process.execPath,
      [script, ...fixtureQmdArgs(['search', '--json', '--', 'fixture term'])],
      { cwd: childDir, encoding: 'utf8', env: { ...ambient, ...options.env } },
    );
    const captured = JSON.parse(output);
    expect(captured).toEqual({
      args: ['search', '--json', '--index', 'index', '--', 'fixture term'],
      index: join(base, 'qmd-index', 'fixture-tenant', 'cache', 'qmd', 'index.sqlite'),
      config: join(base, 'qmd-index', 'fixture-tenant', 'config', 'qmd'),
      cache: join(base, 'qmd-index', 'fixture-tenant', 'cache'),
    });
    expect(options.binary).toBe(FIXTURE_QMD_BINARY);
    expect(options.binary).toContain('node_modules/.bin/qmd');
    expect(readFileSync(ancestor, 'utf8')).toBe(
      'synthetic ancestor configuration must stay unused\n',
    );
  });

  it('binds both availability and ordinary execution to the same explicit index', async () => {
    const calls: string[][] = [];
    const fixture = withFixtureQmdIndex({
      execute: async (args: string[]) => {
        calls.push(args);
        return { exitCode: 0 };
      },
    });
    expect(await fixture.isAvailable()).toBe(true);
    await fixture.execute(['update']);
    expect(calls).toEqual([
      ['--version', '--index', 'index'],
      ['update', '--index', 'index'],
    ]);
  });
  it('preserves maintenance classification and the literal-query terminator', () => {
    const maintenance = fixtureQmdArgs([
      'collection',
      'add',
      '/owned/fixture',
      '--name',
      'fixture',
    ]);
    expect(maintenance.slice(0, 2)).toEqual(['collection', 'add']);
    expect(maintenance.slice(-2)).toEqual(['--index', 'index']);
    expect(fixtureQmdArgs(['update'])[0]).toBe('update');
    expect(fixtureQmdArgs(['search', '--json', '--', '--index literal query'])).toEqual([
      'search',
      '--json',
      '--index',
      'index',
      '--',
      '--index literal query',
    ]);
  });
});
