import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Test-only binding. Never discover a global binary or ancestor index. */
export const FIXTURE_QMD_BINARY = fileURLToPath(
  new URL('../../../node_modules/.bin/qmd', import.meta.url),
);

export function fixtureQmdOptions(base: string, tenant: string) {
  if (!isAbsolute(base)) throw new Error('Absolute owned fixture brain base required');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(tenant)) throw new Error('Invalid fixture tenant');
  const index = join(base, 'qmd-index', tenant);
  // qmd's INDEX_PATH override bypasses its automatic cache-parent mkdir.
  mkdirSync(join(index, 'cache', 'qmd'), { recursive: true });
  mkdirSync(join(index, 'config', 'qmd'), { recursive: true });
  return {
    binary: FIXTURE_QMD_BINARY,
    env: {
      XDG_CONFIG_HOME: join(index, 'config'),
      XDG_CACHE_HOME: join(index, 'cache'),
      QMD_CONFIG_DIR: join(index, 'config', 'qmd'),
      INDEX_PATH: join(index, 'cache', 'qmd', 'index.sqlite'),
    },
  };
}

export function fixtureQmdArgs(args: string[]): string[] {
  // Preserve cmd/sub so RealQmdExecutor keeps its maintenance budget. The
  // selector must precede '--' so literal query text stays literal.
  const terminator = args.indexOf('--');
  const at = terminator < 0 ? args.length : terminator;
  return [...args.slice(0, at), '--index', 'index', ...args.slice(at)];
}

export function fixtureQmdAvailable(): boolean {
  const base = process.env['TEAMKB_BASE_PATH'];
  if (!base) throw new Error('Fixture baseline must run before qmd availability checks');
  const options = fixtureQmdOptions(base, 'availability');
  try {
    execFileSync(options.binary, fixtureQmdArgs(['--version']), {
      env: { ...process.env, ...options.env },
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function withFixtureQmdIndex<T extends { exitCode: number }>(executor: {
  execute(args: string[]): Promise<T>;
}) {
  return {
    execute: (args: string[]) => executor.execute(fixtureQmdArgs(args)),
    isAvailable: async () => (await executor.execute(fixtureQmdArgs(['--version']))).exitCode === 0,
  };
}
