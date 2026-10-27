import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  deriveAuditEventId,
  deriveLinkId,
  isAudienceVisibleToRole,
} from '@qmd-team-intent-kb/common';
import { AuditEvent, IsoDatetime, Sha256Hash } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  MemoryLinksRepository,
  MemoryRepository,
  verifyAuditChain,
  computeEntryHash,
  CURRENT_AUDIT_HASH_VERSION,
} from '@qmd-team-intent-kb/store';
import type { MemoryLink } from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';

import { stalenessDigest } from '../staleness/reviewed-staleness-manifest.js';
import { planContradictions } from './contradiction-planner.js';
import type { CompilationLineage, ContradictionEndpoint } from './contradiction-planner.js';
import {
  parseReviewedContradictionsManifest,
  reviewedContradictionsDigest,
  reviewedContradictionEndpointSnapshot,
  reviewedContradictionStoreDigest,
} from './reviewed-contradictions-manifest.js';
import type {
  ReviewedContradictionsManifest,
  ReviewedContradictionSelection,
} from './reviewed-contradictions-manifest.js';

const RUN_KIND = 'reviewed-contradictions-run-v1';
const EDGE_KIND = 'reviewed-contradictions-edge-v1';

/** Installation-owned captured evidence; never implement these as request-selected URL fetches. */
export interface ReviewedContradictionsDependencies {
  compilations: (
    workspaceId: string,
    compilationId: string,
  ) => readonly {
    lineage: CompilationLineage;
    pageBytes: Uint8Array;
  }[];
  emissionBytes: (workspaceId: string, relativePath: string) => Uint8Array | undefined;
  now?: () => string;
}
export interface ReviewedContradictionsResult {
  linkIds: string[];
  edgeReceiptIds: string[];
  runReceiptId: string;
  replay: boolean;
}

function strictChain(audit: AuditRepository): void {
  const chain = verifyAuditChain(audit);
  if (chain.breaks.length || chain.unverifiedRows)
    throw new Error('Contradictions require a strictly verified audit chain');
}

function validateSelection(
  db: Database.Database,
  manifest: ReviewedContradictionsManifest,
  selection: ReviewedContradictionSelection,
  deps: ReviewedContradictionsDependencies,
): void {
  const captured = deps.compilations(
    selection.lineage.workspaceId,
    selection.lineage.compilationId,
  );
  const current = captured[0];
  if (
    captured.length !== 1 ||
    !current ||
    !isDeepStrictEqual(current.lineage, selection.lineage) ||
    !(current.pageBytes instanceof Uint8Array) ||
    createHash('sha256').update(current.pageBytes).digest('hex') !== selection.lineage.pageSha256
  ) {
    throw new Error('Missing, ambiguous or changed captured compilation lineage');
  }
  const memories = new MemoryRepository(db);
  const audit = new AuditRepository(db);
  const endpoints: ContradictionEndpoint[] = selection.endpoints.map((item) => {
    const memory = memories.findById(item.memoryId);
    if (
      !memory ||
      memory.tenantId !== manifest.tenantId ||
      !isAudienceVisibleToRole(memory.metadata.audience, manifest.role)
    ) {
      throw new Error('Endpoint unavailable within reviewed authority');
    }
    const snapshot = reviewedContradictionEndpointSnapshot(db, item.memoryId, item.promotionId);
    if (
      !isDeepStrictEqual(snapshot, {
        memoryId: item.memoryId,
        memoryDigest: item.memoryDigest,
        storedMemoryDigest: item.storedMemoryDigest,
        promotionId: item.promotionId,
        promotionDigest: item.promotionDigest,
        storedPromotionDigest: item.storedPromotionDigest,
      })
    )
      throw new Error('Endpoint differs from reviewed snapshot');
    const bytes = deps.emissionBytes(selection.lineage.workspaceId, item.emission.relativePath);
    if (
      !(bytes instanceof Uint8Array) ||
      createHash('sha256').update(bytes).digest('hex') !== item.emission.bodySha256
    ) {
      throw new Error('Missing or changed captured emission bytes');
    }
    const promotion = audit
      .findByMemoryAndTenant(item.memoryId, manifest.tenantId)
      .find((event) => event.id === item.promotionId)!;
    return {
      workspaceId: selection.lineage.workspaceId,
      sourceId: item.sourceId,
      emission: item.emission,
      memory,
      promotion,
    };
  });
  const plan = planContradictions({
    tenantId: manifest.tenantId,
    lineages: [selection.lineage],
    endpoints,
    advisories: [
      {
        workspaceId: selection.lineage.workspaceId,
        compilationId: selection.lineage.compilationId,
        pageSha256: selection.lineage.pageSha256,
        sourcePair: selection.endpoints.map((item) => item.sourceId),
      },
    ],
    existingPairs: [],
  });
  if (plan.proposals.length !== 1 || plan.refusals.length)
    throw new Error('Reviewed pair refused: ' + plan.refusals.map((item) => item.code).join(','));
}

/**
 * Internal source-only settlement. Caller owns real authentication, review approval,
 * current policy, physical brain write lock and external anchoring. No activation,
 * lifecycle changes, search behavior or semantic contradiction judgment is supplied.
 */
export function settleReviewedContradictions(
  value: unknown,
  independentlyApprovedDigest: string,
  db: Database.Database,
  deps: ReviewedContradictionsDependencies,
): ReviewedContradictionsResult {
  const manifest = parseReviewedContradictionsManifest(value);
  const digest = reviewedContradictionsDigest(manifest);
  if (Sha256Hash.parse(independentlyApprovedDigest) !== digest)
    throw new Error('Manifest differs from independent review digest');
  if (db.inTransaction) throw new Error('Refusing an existing transaction');
  return db
    .transaction(() => {
      const audit = new AuditRepository(db);
      const links = new MemoryLinksRepository(db);
      strictChain(audit);
      const runs = audit
        .findByMemoryAndTenant(manifest.runId, manifest.tenantId)
        .filter((event) => event.details['kind'] === RUN_KIND);
      if (runs.length > 1 || (runs[0] && runs[0].details['manifestDigest'] !== digest))
        throw new Error('Run identity has a different reviewed manifest');
      const replay = runs.length === 1;
      const now = IsoDatetime.parse(deps.now?.() ?? new Date().toISOString());
      const at = runs[0]?.timestamp ?? now;
      if (Date.parse(manifest.reviewedAt) > Date.parse(at) || Date.parse(at) > Date.parse(now))
        throw new Error('Invalid contradiction review timestamp');
      const expectedLinks: MemoryLink[] = manifest.selections.map((selection) => {
        const [sourceMemoryId, targetMemoryId] = selection.endpoints
          .map((item) => item.memoryId)
          .sort() as [string, string];
        return {
          id: deriveLinkId(sourceMemoryId, targetMemoryId, 'contradicts'),
          sourceMemoryId,
          targetMemoryId,
          linkType: 'contradicts',
          weight: 1,
          createdBy: manifest.actor.id,
          source: 'curator',
          importBatchId: null,
          createdAt: at,
        };
      });
      const eventId = (memoryId: string, kind: string): string =>
        deriveAuditEventId(
          memoryId,
          'governed',
          stalenessDigest({
            kind,
            runId: manifest.runId,
            tenantId: manifest.tenantId,
            manifestDigest: digest,
          }),
        );
      const commonDetails = {
        runId: manifest.runId,
        manifestDigest: digest,
        reviewedAt: manifest.reviewedAt,
        declaredRole: manifest.role,
        reasonDigest: stalenessDigest(manifest.reason),
      };
      const edgeReceipts = expectedLinks.map((link, index) =>
        AuditEvent.parse({
          id: eventId(link.id, EDGE_KIND),
          memoryId: link.sourceMemoryId,
          tenantId: manifest.tenantId,
          action: 'governed',
          reason: 'Reviewed finite contradiction edge',
          actor: manifest.actor,
          timestamp: at,
          details: {
            ...commonDetails,
            kind: EDGE_KIND,
            link,
            evidenceDigest: stalenessDigest(manifest.selections[index]),
          },
        }),
      );
      const runReceipt = AuditEvent.parse({
        id: eventId(manifest.runId, RUN_KIND),
        memoryId: manifest.runId,
        tenantId: manifest.tenantId,
        action: 'governed',
        reason: 'Reviewed finite contradiction settlement',
        actor: manifest.actor,
        timestamp: at,
        details: {
          ...commonDetails,
          kind: RUN_KIND,
          outcomes: expectedLinks.map((link, index) => ({
            link,
            edgeReceiptId: edgeReceipts[index]!.id,
            edgeReceiptDigest: stalenessDigest(edgeReceipts[index]),
          })),
        },
      });
      const receipts = [...edgeReceipts, runReceipt];
      const prior = db
        .prepare(
          `SELECT entry_hash,seq FROM audit_events WHERE id NOT IN (${receipts.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 1`,
        )
        .safeIntegers()
        .get(...receipts.map((event) => event.id)) as
        { entry_hash: string; seq: bigint } | undefined;
      let previousHash = prior?.entry_hash ?? null;
      const rawReceipts = receipts.map((event, index) => {
        const body = {
          id: event.id,
          action: event.action,
          memory_id: event.memoryId,
          tenant_id: event.tenantId,
          actor_json: JSON.stringify(event.actor),
          reason: event.reason ?? null,
          details_json: JSON.stringify(event.details),
          timestamp: event.timestamp,
          prev_entry_hash: previousHash,
        };
        const entry_hash = computeEntryHash(body, CURRENT_AUDIT_HASH_VERSION);
        previousHash = entry_hash;
        return {
          ...body,
          entry_hash,
          hash_version: BigInt(CURRENT_AUDIT_HASH_VERSION),
          seq: (prior?.seq ?? 0n) + BigInt(index + 1),
        };
      });
      const excluded = replay
        ? {
            links: expectedLinks.map((link) => link.id),
            receipts: receipts.map((event) => event.id),
          }
        : { links: [], receipts: [] };
      if (reviewedContradictionStoreDigest(db, excluded) !== manifest.storeDigest)
        throw new Error('Store differs from reviewed snapshot');
      const validate = (): void => {
        for (const selection of manifest.selections)
          validateSelection(db, manifest, selection, deps);
      };
      validate();
      for (const expected of expectedLinks) {
        const existing = db
          .prepare(
            "SELECT id FROM memory_links WHERE link_type='contradicts' AND ((lower(source_memory_id)=? AND lower(target_memory_id)=?) OR (lower(source_memory_id)=? AND lower(target_memory_id)=?))",
          )
          .all(
            expected.sourceMemoryId,
            expected.targetMemoryId,
            expected.targetMemoryId,
            expected.sourceMemoryId,
          ) as { id: string }[];
        if (
          (!replay && existing.length) ||
          (replay && (existing.length !== 1 || existing[0]!.id !== expected.id))
        )
          throw new Error('Existing or reversed duplicate contradiction pair');
      }
      // Trusted callbacks are still checked for accidental mutation before any writes.
      if (reviewedContradictionStoreDigest(db, excluded) !== manifest.storeDigest)
        throw new Error('Store changed during evidence validation');
      const checkReceiptsAndLinks = (): void => {
        for (const expected of expectedLinks) {
          if (!isDeepStrictEqual(links.findById(expected.id), expected))
            throw new Error('Contradiction link missing or changed during settlement');
          const raw = db.prepare('SELECT * FROM memory_links WHERE id=?').get(expected.id);
          if (
            !isDeepStrictEqual(raw, {
              id: expected.id,
              source_memory_id: expected.sourceMemoryId,
              target_memory_id: expected.targetMemoryId,
              link_type: expected.linkType,
              weight: expected.weight,
              created_by: expected.createdBy,
              source: expected.source,
              import_batch_id: expected.importBatchId,
              created_at: expected.createdAt,
            })
          )
            throw new Error('Contradiction raw link differs from exact settlement row');
        }
        for (const [index, expected] of receipts.entries()) {
          const actual = audit
            .findByMemoryAndTenant(expected.memoryId, manifest.tenantId)
            .find((event) => event.id === expected.id);
          if (!isDeepStrictEqual(actual, expected))
            throw new Error('Contradiction receipt missing or changed during settlement');
          const raw = db
            .prepare('SELECT * FROM audit_events WHERE id=?')
            .safeIntegers()
            .get(expected.id);
          if (!isDeepStrictEqual(raw, rawReceipts[index]))
            throw new Error('Contradiction raw receipt differs from exact settlement row');
        }
      };
      if (!replay) {
        expectedLinks.forEach((link, index) => {
          links.insert(link);
          if (!isDeepStrictEqual(links.findById(link.id), link))
            throw new Error('Contradiction link not persisted exactly');
          audit.insert(edgeReceipts[index]!);
        });
        audit.insert(runReceipt);
      }
      checkReceiptsAndLinks();
      validate();
      checkReceiptsAndLinks();
      const afterExcluded = {
        links: expectedLinks.map((link) => link.id),
        receipts: receipts.map((event) => event.id),
      };
      if (reviewedContradictionStoreDigest(db, afterExcluded) !== manifest.storeDigest)
        throw new Error('Non-target store changed during settlement');
      strictChain(audit);
      return {
        linkIds: expectedLinks.map((link) => link.id),
        edgeReceiptIds: edgeReceipts.map((event) => event.id),
        runReceiptId: runReceipt.id,
        replay,
      };
    })
    .immediate();
}
