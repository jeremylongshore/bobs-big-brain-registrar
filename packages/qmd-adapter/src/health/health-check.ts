import type { QmdHealthStatus, StalenessProbe } from '../types.js';
import type { QmdExecutor } from '../executor/executor.js';

/**
 * Evaluate the optional staleness probe without letting it break the health
 * check — a throwing probe (e.g. the store DB is locked) degrades to `null`
 * (unmeasured), never to a crashed probe endpoint.
 */
function probeStaleness(probe?: StalenessProbe): number | null {
  if (probe === undefined) return null;
  try {
    return probe();
  } catch {
    return null;
  }
}

/**
 * Check qmd health — never throws, always returns structured status.
 *
 * `stalenessProbe` (D2) is evaluated even when the qmd binary is unavailable:
 * index staleness is a property of the governed store vs the derived index, so
 * a missing binary makes retrieval degraded AND (still) measurably stale — the
 * two signals are independent.
 */
export async function checkHealth(
  executor: QmdExecutor,
  stalenessProbe?: StalenessProbe,
): Promise<QmdHealthStatus> {
  const stalenessSeconds = probeStaleness(stalenessProbe);

  const available = await executor.isAvailable();
  if (!available) {
    return {
      available: false,
      version: null,
      initialized: false,
      collections: [],
      stalenessSeconds,
    };
  }

  // Get version
  let version: string | null = null;
  try {
    const vResult = await executor.execute(['--version']);
    if (vResult.exitCode === 0) {
      version = vResult.stdout.trim();
    }
  } catch {
    // Non-fatal
  }

  // Get collections (proxy for "initialized")
  let collections: string[] = [];
  let initialized = false;
  try {
    const cResult = await executor.execute(['collection', 'list']);
    if (cResult.exitCode === 0) {
      collections = cResult.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => l.trim());
      initialized = collections.length > 0;
    }
  } catch {
    // Non-fatal
  }

  return { available, version, initialized, collections, stalenessSeconds };
}
