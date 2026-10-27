import { createHash } from 'node:crypto';

import { Author, IsoDatetime, Sha256Hash, TenantId, Uuid } from '@qmd-team-intent-kb/schema';
import { AuditRepository, MemoryRepository } from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';
import { z } from 'zod';

import { auditEventSnapshotDigest, memorySnapshotDigest } from '../recovery/source-archive.js';
import { readStoredMemory, stalenessDigest } from '../staleness/reviewed-staleness-manifest.js';

const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim() !== '' && !value.includes('\0'));
const id = Uuid.refine((value) => value === value.toLowerCase(), 'Use canonical lowercase UUIDs');
const path = text.refine(
  (value) =>
    !value.includes('\\') &&
    !value.includes(':') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
);
const endpoint = z
  .object({
    sourceId: text,
    emission: z.object({ relativePath: path, bodySha256: Sha256Hash, candidateId: id }).strict(),
    memoryId: id,
    memoryDigest: Sha256Hash,
    storedMemoryDigest: Sha256Hash,
    promotionId: id,
    promotionDigest: Sha256Hash,
    storedPromotionDigest: Sha256Hash,
  })
  .strict();
const lineage = z
  .object({
    workspaceId: text,
    compilationId: text,
    pagePath: path,
    pageSha256: Sha256Hash,
    sourceIds: z
      .array(text)
      .min(2)
      .max(10000)
      .refine((items) => new Set(items).size === items.length),
    evidenceRef: text,
  })
  .strict();

/** Review artifact only. An actor/role declaration does not authenticate its caller. */
export const ReviewedContradictionsManifest = z
  .object({
    version: z.literal(1),
    runId: id,
    tenantId: TenantId.refine((value) => value.trim() !== ''),
    actor: Author.strict().refine((value) => value.type === 'human' && value.id.trim() !== ''),
    role: z.enum(['admin', 'owner']),
    reason: text,
    reviewedAt: IsoDatetime,
    storeDigest: Sha256Hash,
    selections: z
      .array(z.object({ lineage, endpoints: z.tuple([endpoint, endpoint]) }).strict())
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const selection of manifest.selections) {
      const pair = selection.endpoints
        .map((item) => item.memoryId)
        .sort()
        .join(':');
      if (seen.has(pair)) context.addIssue({ code: 'custom', message: 'Duplicate unordered pair' });
      seen.add(pair);
    }
  });
export type ReviewedContradictionsManifest = z.infer<typeof ReviewedContradictionsManifest>;
export type ReviewedContradictionSelection = ReviewedContradictionsManifest['selections'][number];

export function parseReviewedContradictionsManifest(
  value: unknown,
): ReviewedContradictionsManifest {
  const parsed = ReviewedContradictionsManifest.parse(value);
  return ReviewedContradictionsManifest.parse(JSON.parse(JSON.stringify(parsed)));
}
export function reviewedContradictionsDigest(value: unknown): string {
  return stalenessDigest(parseReviewedContradictionsManifest(value));
}

/** Read-only bindings. The caller establishes access before collecting review evidence. */
export function reviewedContradictionEndpointSnapshot(
  db: Database.Database,
  memoryId: string,
  promotionId: string,
) {
  return db
    .transaction(() => {
      const memory = new MemoryRepository(db).findById(id.parse(memoryId));
      const raw = db.prepare('SELECT * FROM audit_events WHERE id=?').get(id.parse(promotionId));
      const promotion =
        memory &&
        new AuditRepository(db)
          .findByMemoryAndTenant(memoryId, memory.tenantId)
          .find((item) => item.id === promotionId);
      if (!memory || !raw || !promotion) throw new Error('Missing contradiction endpoint witness');
      return {
        memoryId,
        memoryDigest: memorySnapshotDigest(memory),
        storedMemoryDigest: stalenessDigest(readStoredMemory(db, memoryId)),
        promotionId,
        promotionDigest: auditEventSnapshotDigest(promotion),
        storedPromotionDigest: stalenessDigest(raw),
      };
    })
    .deferred();
}

const quote = (value: string): string => '"' + value.replaceAll('"', '""') + '"';

/**
 * Exact logical snapshot of main-store schema and every table, including unknown
 * columns and FTS shadow tables. Integers/blobs retain their SQLite types. No
 * filesystem bytes, query caches, pragmas or external side effects are attested.
 * Replay excludes only its deterministic, independently checked appended rows.
 */
export function reviewedContradictionStoreDigest(
  db: Database.Database,
  excluded: { links: readonly string[]; receipts: readonly string[] } = { links: [], receipts: [] },
): string {
  return db
    .transaction(() => {
      const databases = db.prepare('PRAGMA database_list').all() as { name: string }[];
      if (
        databases.some((item) => item.name !== 'main' && item.name !== 'temp') ||
        db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()
      ) {
        throw new Error(
          'Contradiction settlement requires a main-only store without temporary objects',
        );
      }
      const schema = db
        .prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name')
        .all();
      const tables = db
        .prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const tableKinds = db.prepare('PRAGMA main.table_list').all() as {
        name: string;
        wr: number;
      }[];
      const state = tables.map(({ name }) => {
        const declaredColumns = db
          .prepare(`SELECT * FROM main.${quote(name)}`)
          .columns()
          .map((column) => column.name);
        let projection = '*';
        if (tableKinds.find((table) => table.name === name)?.wr !== 1) {
          const hidden = ['rowid', '_rowid_', 'oid'].find(
            (alias) => !declaredColumns.includes(alias),
          );
          if (!hidden) throw new Error('Cannot bind hidden rowid in contradiction store snapshot');
          let alias = '__reviewed_rowid__';
          while (declaredColumns.includes(alias)) alias += '_';
          projection = `${quote(hidden)} AS ${quote(alias)}, *`;
        }
        const statement = db
          .prepare(`SELECT ${projection} FROM main.${quote(name)}`)
          .raw()
          .safeIntegers();
        const columns = statement.columns().map((column) => column.name);
        const idColumn = columns.indexOf('id');
        const omitted = new Set(
          name === 'memory_links'
            ? excluded.links
            : name === 'audit_events'
              ? excluded.receipts
              : [],
        );
        const rows = (statement.all() as unknown[][])
          .filter((row) => !omitted.has(row[idColumn] as string))
          .map((row) =>
            JSON.stringify(
              row.map((value) => {
                if (typeof value === 'bigint') return ['integer', value.toString()];
                if (typeof value === 'number')
                  return ['real', Object.is(value, -0) ? '-0' : value.toString()];
                if (value instanceof Uint8Array)
                  return ['blob', Buffer.from(value).toString('hex')];
                return [typeof value, value];
              }),
            ),
          )
          .sort();
        return { name, columns, rows };
      });
      return createHash('sha256').update(JSON.stringify({ schema, state })).digest('hex');
    })
    .deferred();
}
