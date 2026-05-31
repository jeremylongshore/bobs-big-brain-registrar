import { resolve } from 'node:path';

import { createDatabase } from '@qmd-team-intent-kb/store';
import {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  ExportStateRepository,
} from '@qmd-team-intent-kb/store';
import { resolveTeamKbPath } from '@qmd-team-intent-kb/common';
import { QmdAdapter } from '@qmd-team-intent-kb/qmd-adapter';
import { loadDaemonConfig } from './config.js';
import { PinoDaemonLogger } from './pino-logger.js';
import { dispatch } from './cli.js';

/**
 * CLI entry point for the edge daemon.
 *
 * Usage: DAEMON_TENANT_ID=my-team tsx src/main.ts [start|stop|status|run-once]
 *
 * Default subcommand is `start` when none is provided.
 */
async function main(): Promise<void> {
  const rootLogger = new PinoDaemonLogger();

  let config;
  try {
    config = loadDaemonConfig();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rootLogger.error(`Configuration error: ${msg}`);
    process.exit(1);
  }

  const logger = rootLogger.child({ tenantId: config.tenantId });

  const dbPath = resolveTeamKbPath('teamkb.db');
  const db = createDatabase({ path: dbPath });

  const daemonDeps = {
    candidateRepo: new CandidateRepository(db),
    memoryRepo: new MemoryRepository(db),
    policyRepo: new PolicyRepository(db),
    auditRepo: new AuditRepository(db),
    exportStateRepo: new ExportStateRepository(db),
    // Point the adapter at the SAME dir the exporter writes to (resolved to
    // absolute so qmd's collection sources match git-exporter's output
    // regardless of cwd). git-exporter's file-writer resolves the same
    // relative `exportOutputDir` from this process's cwd.
    qmdAdapter: new QmdAdapter({
      tenantId: config.tenantId,
      exportDir: resolve(config.exportOutputDir),
    }),
  };

  const exitCode = await dispatch(process.argv.slice(2), { config, daemonDeps, logger });
  process.exit(exitCode);
}

void main();
