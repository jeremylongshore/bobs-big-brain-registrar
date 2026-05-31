import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { RealQmdExecutor } from '../executor/real-executor.js';

// Sync check required — describe.skipIf does not support async conditions
function isQmdAvailable(): boolean {
  try {
    execSync('which qmd', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const qmdAvailable = isQmdAvailable();

describe('RealQmdExecutor', () => {
  const executor = new RealQmdExecutor();

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
      // qmd 2.0.1 rejects unknown flags; --version must still succeed, proving
      // we no longer prepend --data-dir. Isolation is via XDG_* env instead.
      const exec = new RealQmdExecutor({
        env: { XDG_CONFIG_HOME: '/tmp/qmd-iso-cfg', XDG_CACHE_HOME: '/tmp/qmd-iso-cache' },
      });
      const result = await exec.execute(['--version']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('qmd');
    }, 15000);
  });
});
