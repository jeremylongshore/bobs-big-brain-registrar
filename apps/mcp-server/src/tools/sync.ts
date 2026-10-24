import { RealQmdExecutor, describeQmdFailure } from '@qmd-team-intent-kb/qmd-adapter';
import type { McpServerConfig } from '../config.js';

interface SyncResult {
  stdout: string;
  stderr: string;
  message: string;
}

/** One lifecycle engine; sync retains its original 5s version / 120s embed limits. */
function syncExecutor(config: McpServerConfig): RealQmdExecutor {
  return new RealQmdExecutor({
    binary: config.qmdBinary,
    ownedRuntime: config.qmdRuntime,
    tenant: { id: config.tenantId, basePath: config.basePath },
    timeout: 5_000,
    maintenanceTimeout: 120_000,
  });
}

/** Local tenant-bound vector sync; team mode never invokes local qmd. */
export async function runSync(config: McpServerConfig): Promise<SyncResult> {
  if (config.apiUrl) throw new Error('qmd sync is local-only; team mode uses the remote brain');
  const result = await syncExecutor(config).execute(['embed']);
  if (result.exitCode !== 0) {
    const reason =
      result.failure?.kind === 'timeout'
        ? `qmd embed timed out (limit 120000 ms); tracked process-group termination ${result.failure.groupTerminated ? 'confirmed' : 'not confirmed'}`
        : describeQmdFailure(['embed'], result).message;
    throw new Error(`qmd embed failed: ${reason}`);
  }
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    message: 'qmd embed completed successfully',
  };
}

/** Probe only a local configuration; no selection or probe in team mode. */
export async function isQmdAvailable(config: McpServerConfig): Promise<boolean> {
  if (config.apiUrl) return false;
  return syncExecutor(config).isAvailable();
}
