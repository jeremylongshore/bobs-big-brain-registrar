import type { CurationBatchResult } from '@qmd-team-intent-kb/curator';
import type { ExportResult } from '@qmd-team-intent-kb/git-exporter';
import type {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  ExportStateRepository,
  IndexStateRepository,
} from '@qmd-team-intent-kb/store';
import type { QmdAdapter } from '@qmd-team-intent-kb/qmd-adapter';
import type { RepoContext } from '@qmd-team-intent-kb/repo-resolver';

/** Configuration for the edge daemon */
export interface DaemonConfig {
  tenantId: string;
  /** Polling interval in milliseconds. Default 10_000. */
  pollIntervalMs: number;
  /** Maximum candidates ingested per cycle. Default 100. */
  maxCandidatesPerCycle: number;
  /** Maximum spool file size in bytes before skipping. Default 10MB. */
  maxSpoolFileSizeBytes: number;
  /** Whether to run git export after curation. Default true. */
  enableExport: boolean;
  /** Whether to update qmd index after export. Default true. */
  enableIndexUpdate: boolean;
  /** Whether to run staleness sweep. Default true. */
  enableStalenessSweep: boolean;
  /** Number of days before active memories are auto-deprecated. Default 90. */
  staleDays: number;
  /** Spool directory path. Default ~/.teamkb/spool/. */
  spoolDir?: string;
  /** Export output directory. Default kb-export/. */
  exportOutputDir: string;
  /** Export target identifier. Default kb-export-default. */
  exportTargetId: string;
  /** Jaccard similarity threshold for supersession. Default 0.6. */
  supersessionThreshold: number;
  /** PID file path for locking. Default ~/.teamkb/daemon.pid. */
  pidFilePath: string;
  /** When true, candidates whose repoUrl does not match the daemon's resolved repo are skipped. Default false. */
  scopeByRepo: boolean;
  /** HTTP health server port. 0 = disabled. Default 0. */
  healthPort?: number;
  /** Host/address the HTTP health server binds to. Default '127.0.0.1'. Use '0.0.0.0' inside Docker/Kubernetes so external probes can reach it. */
  healthHost: string;
  /** Maximum retry attempts for transient step errors. Default 3. */
  maxRetries: number;
  /** Base delay in ms for exponential backoff. Default 500. */
  retryBaseDelayMs: number;
  /** Maximum random jitter added to backoff delay in ms. Default 200. */
  retryMaxJitterMs: number;
  /** Injectable clock for deterministic tests. */
  nowFn?: () => string;
  /** Injectable sleep for deterministic retry tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Repository dependencies injected into the daemon */
export interface DaemonDependencies {
  candidateRepo: CandidateRepository;
  memoryRepo: MemoryRepository;
  policyRepo: PolicyRepository;
  auditRepo: AuditRepository;
  exportStateRepo: ExportStateRepository;
  /** Optional — skip index update if absent. */
  qmdAdapter?: QmdAdapter;
  /**
   * Optional — when present, a SUCCESSFUL index update records
   * `last_indexed_at` for the tenant (D1/D2 freshness consumption: the daemon's
   * cycle is the poll loop that absorbs pending promotions, so it is the one
   * that clears the derived index-dirty state and keeps the staleness gauge
   * honest). Absent (legacy/test wiring) → freshness simply stays unmeasured.
   */
  indexStateRepo?: IndexStateRepository;
  /**
   * Pre-resolved repo context, stashed at daemon startup.
   *
   * - `undefined` (absent): `runCycle` falls back to calling `resolveRepoContext()` itself.
   *   This preserves backward compatibility for test paths that do not set this field.
   * - `null`: resolution was attempted but failed at startup; scoping is disabled with a
   *   warning (graceful-degradation contract).
   * - `RepoContext`: successfully resolved — used directly, no per-cycle subprocess cost.
   */
  repoContext?: RepoContext | null;
}

/** Result of a single ingest step */
export interface IngestStepResult {
  ingested: number;
  errors: string[];
}

/** Result of a qmd index update step */
export interface IndexUpdateResult {
  ok: boolean;
  error?: string;
}

/** Result of a staleness sweep step */
export interface StalenessSweepResult {
  scanned: number;
  deprecated: number;
  errors: string[];
}

/** Aggregate result of one full daemon cycle */
export interface CycleResult {
  startedAt: string;
  completedAt: string;
  ingest: IngestStepResult;
  curation: CurationBatchResult | null;
  staleness: StalenessSweepResult | null;
  export: ExportResult | null;
  indexUpdate: IndexUpdateResult | null;
}

/** Daemon lifecycle state */
export type DaemonState = 'idle' | 'running' | 'stopping' | 'stopped';

/** Logger interface for daemon health/status output */
export interface DaemonLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
