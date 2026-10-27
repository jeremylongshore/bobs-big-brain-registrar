import { createHash } from 'node:crypto';

import { Author, IsoDatetime, Sha256Hash, TenantId, Uuid } from '@qmd-team-intent-kb/schema';
import { MemoryRepository } from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';
import { z } from 'zod';

import { memorySnapshotDigest } from '../recovery/source-archive.js';

const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim() !== '');
const binding = z.object({ id: Uuid, snapshotDigest: Sha256Hash }).strict();
const selection = z
  .object({
    memoryId: Uuid,
    snapshotDigest: Sha256Hash,
    storedRowDigest: Sha256Hash,
    ruleId: text,
    ruleDigest: Sha256Hash,
    scope: z.enum(['intent-solutions-estate', 'external', 'unresolved']),
    scopeEvidenceRef: text,
    deprecationReceipt: binding.optional(),
  })
  .strict();

/** A review artifact, never authentication or permission by itself. */
export const ReviewedStalenessManifest = z
  .object({
    version: z.literal(1),
    runId: Uuid,
    tenantId: TenantId.refine((value) => value.trim() !== ''),
    operation: z.enum(['deprecate', 'reactivate']),
    actor: Author.strict().refine((actor) => actor.type === 'human' && actor.id.trim() !== ''),
    role: z.enum(['admin', 'owner']),
    reason: text,
    reviewedAt: IsoDatetime,
    selections: z.array(selection).min(1).max(100),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const item of manifest.selections) {
      if (
        ids.has(item.memoryId) ||
        (manifest.operation === 'reactivate') !== (item.deprecationReceipt !== undefined)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate selection or wrong reversal binding',
        });
      }
      ids.add(item.memoryId);
    }
  });
export type ReviewedStalenessManifest = z.infer<typeof ReviewedStalenessManifest>;
export type ReviewedStalenessSelection = ReviewedStalenessManifest['selections'][number];
export type StoredMemoryRow = Record<string, unknown>;

/** Validate before JSON normalization so unknown fields cannot disappear unchecked. */
export function parseReviewedStalenessManifest(value: unknown): ReviewedStalenessManifest {
  const parsed = ReviewedStalenessManifest.parse(value);
  return ReviewedStalenessManifest.parse(JSON.parse(JSON.stringify(parsed)));
}

/** Same object-key normalization as the existing recovery manifest digests. */
export function stalenessDigest(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown): unknown => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          return Object.fromEntries(
            Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          );
        }
        return item;
      }),
    )
    .digest('hex');
}

export function reviewedStalenessDigest(value: unknown): string {
  return stalenessDigest(parseReviewedStalenessManifest(value));
}

/** Read observation only; canonical repositories remain the sole write surface. */
export function readStoredMemory(connection: Database.Database, id: string): StoredMemoryRow {
  const row = connection.prepare('SELECT * FROM curated_memories WHERE id = ?').get(id);
  if (row === undefined) throw new Error('Selected stored memory is missing');
  return row as StoredMemoryRow;
}

/** Caller establishes read authority; returns hashes, not the stored content. */
export function reviewedStalenessSnapshot(connection: Database.Database, memoryId: string) {
  Uuid.parse(memoryId);
  return connection
    .transaction(() => {
      const memory = new MemoryRepository(connection).findById(memoryId);
      if (memory === null) throw new Error('Selected canonical memory is missing');
      return {
        memoryId,
        snapshotDigest: memorySnapshotDigest(memory),
        storedRowDigest: stalenessDigest(readStoredMemory(connection, memoryId)),
      };
    })
    .deferred();
}
