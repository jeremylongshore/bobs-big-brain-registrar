import { randomUUID } from 'node:crypto';
import type { DaemonConfig, DaemonDependencies, DaemonLogger } from '../types.js';
import {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  ExportStateRepository,
  IndexStateRepository,
} from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { FIXED_NOW, DEFAULT_TENANT } from '@qmd-team-intent-kb/test-fixtures';

export {
  makeCandidate,
  makePolicy,
  FIXED_NOW as NOW,
  DEFAULT_TENANT as TENANT,
} from '@qmd-team-intent-kb/test-fixtures';

const NOW = FIXED_NOW;
const TENANT = DEFAULT_TENANT;

/** Create all daemon dependencies from an in-memory test database */
export function makeDeps(db: Database.Database): DaemonDependencies {
  return {
    candidateRepo: new CandidateRepository(db),
    memoryRepo: new MemoryRepository(db),
    policyRepo: new PolicyRepository(db),
    auditRepo: new AuditRepository(db),
    exportStateRepo: new ExportStateRepository(db),
    // Mirrors production wiring (main.ts): a successful index update records
    // last_indexed_at, which the D2 staleness gauge consumes.
    indexStateRepo: new IndexStateRepository(db),
  };
}

/** Create a default test config */
export function makeConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  return {
    tenantId: TENANT,
    pollIntervalMs: 100, // fast for tests
    maxCandidatesPerCycle: 100,
    maxSpoolFileSizeBytes: 10 * 1024 * 1024,
    enableExport: false, // default off in tests — no filesystem side effects
    enableIndexUpdate: false,
    enableStalenessSweep: false, // default off in tests
    staleDays: 90,
    exportOutputDir: 'kb-export/',
    exportTargetId: 'kb-export-default',
    supersessionThreshold: 0.6,
    pidFilePath: '/tmp/daemon-test-' + randomUUID() + '.pid',
    scopeByRepo: false,
    healthHost: '127.0.0.1',
    maxRetries: 0, // no retries in tests by default — avoids delay
    retryBaseDelayMs: 0,
    retryMaxJitterMs: 0,
    sleepFn: async (_ms: number) => {}, // no-op sleep — deterministic
    nowFn: () => NOW,
    ...overrides,
  };
}

/** Recording logger for test assertions */
export class RecordingLogger implements DaemonLogger {
  readonly messages: Array<{ level: string; message: string }> = [];

  info(message: string): void {
    this.messages.push({ level: 'info', message });
  }
  warn(message: string): void {
    this.messages.push({ level: 'warn', message });
  }
  error(message: string): void {
    this.messages.push({ level: 'error', message });
  }
}

/** Serialise a candidate to a JSONL line */
function candidateToJsonl(candidate: MemoryCandidate): string {
  return JSON.stringify(candidate);
}

/** Write candidates to a spool file */
export async function writeSpoolFile(
  dir: string,
  name: string,
  candidates: MemoryCandidate[],
): Promise<string> {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const filepath = join(dir, name);
  const lines = candidates.map(candidateToJsonl).join('\n');
  await writeFile(filepath, lines, 'utf8');
  return filepath;
}
