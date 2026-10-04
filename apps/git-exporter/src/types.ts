import type { CuratedMemory } from '@qmd-team-intent-kb/schema';

export interface ExportConfig {
  /** Root directory for exported files (e.g., kb-export/) */
  outputDir: string;
  /** Identifier for this export target (e.g., 'kb-export-default') */
  targetId: string;
  /** Optional tenant filter */
  tenantId?: string;
  /**
   * Reconcile mode: ignore the incremental `lastExportedAt` filter and converge
   * the whole export tree on the DB. Writes missing/changed files, archives
   * retired ones, and removes stale copies (wrong directory, restricted
   * sensitivity, or memories no longer in the DB). Default false (incremental).
   */
  reconcile?: boolean;
  /**
   * Reconcile only: refuse to remove orphan files (ids absent from the DB) when
   * more than this many would go. A mirror reports green fastest when the
   * source is empty or wrong, so mass deletion needs an explicit ceiling.
   * Default 50. Ignored in incremental mode.
   */
  maxOrphanRemovals?: number;
}

/** Orphan removals refused by the reconcile mass-delete guard. */
export interface RemovalBlocked {
  orphans: number;
  limit: number;
}

/**
 * A memory that could not be exported and was set aside (5bm.12) instead of
 * aborting the whole run — e.g. an unknown category the fail-closed
 * directory-mapper (5bm.5) refuses to place. Reported so the operator can fix
 * it at source (recategorize, 5bm.7); recategorizing bumps `updatedAt`, which
 * naturally re-enters the memory into the next export once it maps cleanly.
 */
export interface QuarantinedMemory {
  /** Memory id set aside. */
  id: string;
  /** The category that could not be mapped (empty string if unavailable). */
  category: string;
  /** Human-readable reason the memory was quarantined. */
  reason: string;
}

export interface ExportResult {
  /** File paths written */
  written: string[];
  /** File paths moved to archive */
  archived: string[];
  /** File paths removed */
  removed: string[];
  /** Memory IDs skipped due to sensitivity restrictions */
  skipped: string[];
  /** Memories set aside due to an unmappable/unformattable state (5bm.12) */
  quarantined: QuarantinedMemory[];
  /** Count of files that didn't need updating */
  unchanged: number;
  totalProcessed: number;
  /** Reconcile only: orphan removals were refused because they exceeded the cap. */
  removalBlocked?: RemovalBlocked;
}

export interface FrontmatterData {
  id: string;
  title: string;
  category: string;
  lifecycle: string;
  trustLevel: string;
  sensitivity: string;
  tenantId: string;
  contentHash: string;
  /** "type:id" format */
  author: string;
  promotedAt: string;
  updatedAt: string;
  version: number;
  tags: string[];
  supersededBy?: string;
}

export interface ExportChangeset {
  toWrite: Array<{ memory: CuratedMemory; filePath: string }>;
  toArchive: Array<{ memory: CuratedMemory; fromPath: string; toPath: string }>;
  toRemove: string[];
  /** Memories that could not be mapped to a path and were set aside (5bm.12). */
  quarantined: QuarantinedMemory[];
  /** Reconcile only: set when the orphan-removal guard refused the removals. */
  removalBlocked?: RemovalBlocked;
}
