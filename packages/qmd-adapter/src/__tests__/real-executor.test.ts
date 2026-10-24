import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  fixtureQmdOptions,
  fixtureQmdAvailable,
  withFixtureQmdIndex,
} from '@qmd-team-intent-kb/test-fixtures';
import { RealQmdExecutor } from '../executor/real-executor.js';

const qmdAvailable = fixtureQmdAvailable();

describe('RealQmdExecutor', () => {
  const executor = withFixtureQmdIndex(
    new RealQmdExecutor(fixtureQmdOptions(process.env['TEAMKB_BASE_PATH']!, 'executor')),
  );

  it('accepts an env option for XDG isolation', () => {
    const exec = new RealQmdExecutor({
      env: { XDG_CONFIG_HOME: '/tmp/cfg', XDG_CACHE_HOME: '/tmp/cache' },
    });
    expect(exec).toBeDefined();
  });

  describe.skipIf(!qmdAvailable)('with qmd binary', () => {
    it('detects qmd availability', async () => {
      const available = await executor.isAvailable();
      expect(available).toBe(true);
    }, 15000);

    it('gets qmd version', async () => {
      const result = await executor.execute(['--version']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('qmd');
    }, 15000);

    it('handles invalid commands gracefully', async () => {
      const result = await executor.execute(['invalid-command-that-does-not-exist']);
      expect(result.exitCode).not.toBe(0);
    }, 15000);

    it('does not pass the (nonexistent) --data-dir flag to qmd', async () => {
      // qmd 2.x rejects unknown flags; --version must still succeed, proving
      // we no longer prepend --data-dir. Isolation is via XDG_* env instead.
      const options = fixtureQmdOptions(process.env['TEAMKB_BASE_PATH']!, 'executor-isolation');
      const exec = withFixtureQmdIndex(
        new RealQmdExecutor({
          ...options,
          env: {
            ...options.env,
            XDG_CONFIG_HOME: join(process.env['TEAMKB_BASE_PATH']!, 'version-config'),
            XDG_CACHE_HOME: join(process.env['TEAMKB_BASE_PATH']!, 'version-cache'),
          },
        }),
      );
      const result = await exec.execute(['--version']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('qmd');
    }, 15000);
  });
});
