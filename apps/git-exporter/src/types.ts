import type { CuratedMemory } from '@qmd-team-intent-kb/schema';

export interface ExportConfig {
  /** Root directory for exported files (e.g., kb-export/) */
  outputDir: string;
  /** Identifier for this export target (e.g., 'kb-export-default') */
  targetId: string;
  /** Optional tenant filter */
  tenantId?: string;
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
}
