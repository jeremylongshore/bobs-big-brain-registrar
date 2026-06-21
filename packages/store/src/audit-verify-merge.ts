/**
 * MERGE-AWARE audit-chain verifier (bead `8da.8`).
 *
 * `verifyAuditChain` (audit-verify.ts) is a LINEAR walker: it tracks
 * `expectedPrev` as the previous row's `entry_hash` in `(timestamp ASC, id ASC)`
 * order and reports a break the moment a row's `prev_entry_hash` does not match.
 * That contract is exactly right for one clone's own history, and exactly wrong
 * for a MERGE. When `mergeGovern` (apps/curator merge-gate.ts) folds two clones'
 * promoted rows into one DB, the merged rows are timestamped by a deterministic
 * `mergeClock(index)` over the id-sorted traversal - so the merged chain is
 * linear *in id order*, not in the wallclock order two independently-evolving
 * clones happened to mint. Concatenating or interleaving the two clones' rows by
 * wallclock therefore fires `PREV_LINK_MISMATCH` at the merge boundary: each
 * clone's chain is internally linear, but their wallclock concatenation is not.
 *
 * This module does the five things the linear verifier cannot:
 *
 *  1. **Per-clone linear validation** - run the existing `verifyAuditChain` over
 *     each clone in isolation. A broken clone chain is a tamper event in that
 *     clone's OWN history, surfaced before any merge-level reasoning. The per-row
 *     `hash_version` dispatch already in `verifyAuditChain` handles mixed v1/v2
 *     rows transparently.
 *
 *  2. **Canonical id-based ordering as a first-class contract** - the merged
 *     chain's ordering is owned HERE, by the verifier, not borrowed from the
 *     gate's implicit sort. The union of both clones' rows is ordered by
 *     content-derived event `id` (the UUID v5 the `promote()` path mints from
 *     `(memoryId, ruleId, candidateId, ...)`, enforced by bead `8da.5`). That
 *     id is content-stable: identical across clones for the same logical event,
 *     independent of wallclock. Any caller wanting an ordering guarantee uses
 *     this verifier; it does not trust the gate to have sorted correctly.
 *
 *  3. **Merged-chain re-walk (byte-identical re-derivation)** - after sorting the
 *     union by event id, re-walk the sequence exactly as `verifyAuditChain` does,
 *     recomputing each row's `entry_hash` under its stored `hash_version` and
 *     checking `prev_entry_hash` against the id-sorted predecessor (NOT the
 *     wallclock predecessor). Because `mergeClock` assigns timestamps in
 *     id-sorted order and the v2 `entry_hash` excludes `timestamp` (audit-chain.ts),
 *     a clean merge re-walks to byte-identical hashes - zero breaks. A
 *     `PREV_LINK_MISMATCH` in the id-sorted walk means the merged DB was NOT
 *     produced by `mergeGovern` (or was tampered/reordered after the fact).
 *
 *  4. **Signed DAG anchor cross-check (bead `8da.7`)** - re-read the signed merge
 *     anchor and assert: (a) its `signerPublicKey` Ed25519 signature verifies;
 *     (b) its `parents` SET equals the two clone chain heads (order-independent);
 *     (c) its `chainHead` equals the head of the id-sorted merged chain. (a)
 *     proves WHO wrote the anchor, not merely that its bytes are self-consistent;
 *     (b) proves the merge attests to the correct parent chains; (c) proves the
 *     anchor describes THIS merged head, not a different one.
 *
 *  5. **`MergeAuditVerifyResult`** - carries `cloneA`, `cloneB`, `mergedChain`
 *     (the three `AuditVerifyResult`s), `dagAnchor` (the signed-anchor result),
 *     and an `ok` that is true only when all four sub-checks are clean.
 *
 * Like every verifier in this package, it NEVER throws on tamper - it surfaces
 * every discrepancy in the result. It throws only on real I/O failure.
 *
 * @module audit-verify-merge
 */

import { computeEntryHash, type AuditHashVersion } from './audit-chain.js';
import { verifyAuditChain, type AuditVerifyResult } from './audit-verify.js';
import type { AuditChainRow } from './repositories/audit-repository.js';
import {
  readSignedMergeAnchors,
  verifyMergeAnchorSignature,
  type SignedMergeAnchorRecord,
} from './signed-merge-anchor.js';

/**
 * Resolve a row's stored hash version to the serialiser discriminant. NULL /
 * absent / any value other than 2 is the original v1 (timestamp-in-hash) form,
 * the same rule `verifyAuditChain` applies, kept in lock-step here.
 */
function rowHashVersion(row: AuditChainRow): AuditHashVersion {
  return row.hash_version === 2 ? 2 : 1;
}

/** A discrepancy against the signed DAG anchor for a merge. */
export interface DagAnchorBreak {
  /** Zero-indexed position in the signed-anchor log. */
  index: number;
  reason:
    | 'DAG_SIGNATURE_INVALID' // the Ed25519 signature does not verify
    | 'DAG_PARENT_MISMATCH' // the anchor's parents != the two clone heads
    | 'DAG_HEAD_MISMATCH' // the anchor's chainHead != the merged chain head
    | 'DAG_ANCHOR_MISSING'; // no signed merge anchor was found to cross-check
  detail: string;
}

/** Result of cross-checking one signed DAG anchor against the merge. */
export interface DagAnchorVerifyResult {
  /** True iff the anchor signs, attests the right parents, and the right head. */
  ok: boolean;
  breaks: DagAnchorBreak[];
}

/**
 * Aggregate result of a merge-aware verification pass. `ok` is true ONLY when
 * every sub-check is clean: both clones verify linearly, the id-sorted merged
 * chain re-walks byte-identically, and the signed DAG anchor cross-checks.
 */
export interface MergeAuditVerifyResult {
  /** Linear verification of clone A in isolation. */
  cloneA: AuditVerifyResult;
  /** Linear verification of clone B in isolation. */
  cloneB: AuditVerifyResult;
  /** Re-walk of the id-sorted union of both clones' rows (the merged chain). */
  mergedChain: AuditVerifyResult;
  /** Cross-check of the signed DAG anchor (bead 8da.7). */
  dagAnchor: DagAnchorVerifyResult;
  ok: boolean;
}

/**
 * The CANONICAL merge ordering contract: order a set of audit rows by their
 * content-derived event `id`. This is the same total order `mergeGovern` uses
 * (it sorts the union by id and assigns `mergeClock(index)` in that order), but
 * it is OWNED here - the verifier does not trust the gate to have ordered
 * correctly, it re-derives the ordering and checks the chain against it.
 *
 * The sort is stable, content-stable, and clone-independent: the same logical
 * event has the same id on every clone, so it lands at the same position. Pure
 * (does not mutate its argument).
 */
export function canonicalMergeOrder(rows: readonly AuditChainRow[]): AuditChainRow[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Re-walk a row sequence as a hash chain, recomputing each row's `entry_hash`
 * under its stored `hash_version` and checking `prev_entry_hash` linkage against
 * the PRECEDING row in the given order. This is the same walk `verifyAuditChain`
 * runs, factored so the merge verifier can apply it to the id-sorted union (the
 * canonical merge order) rather than the repository's wallclock order.
 *
 * Pre-migration rows (both hash columns NULL) are counted `unverified`, not
 * broken - identical to `verifyAuditChain`.
 */
function walkChain(orderedRows: readonly AuditChainRow[]): AuditVerifyResult {
  const breaks: AuditVerifyResult['breaks'] = [];
  let unverifiedRows = 0;
  let cleanRows = 0;
  let expectedPrev: string | null = null;

  for (let i = 0; i < orderedRows.length; i++) {
    const row = orderedRows[i]!;

    if (row.entry_hash === null && row.prev_entry_hash === null) {
      unverifiedRows++;
      continue;
    }

    const expectedHash = computeEntryHash(
      {
        id: row.id,
        action: row.action,
        memory_id: row.memory_id,
        tenant_id: row.tenant_id,
        actor_json: row.actor_json,
        reason: row.reason,
        details_json: row.details_json,
        timestamp: row.timestamp,
        prev_entry_hash: row.prev_entry_hash,
      },
      rowHashVersion(row),
    );

    const prevMatches = row.prev_entry_hash === expectedPrev;
    const entryMatches = row.entry_hash === expectedHash;

    if (prevMatches && entryMatches) {
      cleanRows++;
      expectedPrev = row.entry_hash;
      continue;
    }

    let reason: AuditVerifyResult['breaks'][number]['reason'];
    if (!prevMatches && !entryMatches) {
      reason = 'PREV_LINK_AND_ENTRY_HASH_MISMATCH';
    } else if (!prevMatches) {
      reason = 'PREV_LINK_MISMATCH';
    } else {
      reason = 'ENTRY_HASH_MISMATCH';
    }

    breaks.push({
      index: i,
      id: row.id,
      action: row.action,
      timestamp: row.timestamp,
      tenantId: row.tenant_id,
      expectedEntryHash: expectedHash,
      actualEntryHash: row.entry_hash,
      expectedPrevEntryHash: expectedPrev,
      actualPrevEntryHash: row.prev_entry_hash,
      reason,
    });

    // Re-anchor on whatever the tampered row stored, so one tamper does not
    // cascade every following row into a break - same honest accounting as
    // verifyAuditChain.
    expectedPrev = row.entry_hash;
  }

  return {
    totalRows: orderedRows.length,
    unverifiedRows,
    cleanRows,
    breaks,
  };
}

/** Order-independent string-set equality (clone heads are a SET, not a tuple). */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Head `entry_hash` of a chain's CHAINED rows ('' when none). */
function chainHeadOf(rows: readonly AuditChainRow[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const h = rows[i]!.entry_hash;
    if (h !== null) return h;
  }
  return '';
}

/**
 * Cross-check a single signed DAG anchor against the two clone heads and the
 * merged chain head. The anchor used is the LAST one in the log - the most
 * recent merge attestation.
 *
 * Three guards, all surfaced as breaks (never thrown):
 *  - signature: the Ed25519 `signature` verifies against the embedded
 *    `signerPublicKey` - proves the holder of the private key wrote it;
 *  - parents: the anchor's `parents` SET equals the two clone chain heads;
 *  - head: the anchor's `chainHead` equals the merged chain head.
 */
function verifyDagAnchor(
  anchor: SignedMergeAnchorRecord | undefined,
  cloneAHead: string,
  cloneBHead: string,
  mergedHead: string,
): DagAnchorVerifyResult {
  const breaks: DagAnchorBreak[] = [];

  if (anchor === undefined) {
    breaks.push({
      index: -1,
      reason: 'DAG_ANCHOR_MISSING',
      detail: 'no signed merge anchor found to cross-check the merge',
    });
    return { ok: false, breaks };
  }

  if (!verifyMergeAnchorSignature(anchor)) {
    breaks.push({
      index: 0,
      reason: 'DAG_SIGNATURE_INVALID',
      detail: 'Ed25519 signature does not verify against the embedded signerPublicKey',
    });
  }

  if (!sameSet(anchor.parents, [cloneAHead, cloneBHead])) {
    breaks.push({
      index: 0,
      reason: 'DAG_PARENT_MISMATCH',
      detail: `anchor parents [${[...anchor.parents].sort().join(', ')}] != clone heads [${[
        cloneAHead,
        cloneBHead,
      ]
        .sort()
        .join(', ')}]`,
    });
  }

  if (anchor.chainHead !== mergedHead) {
    breaks.push({
      index: 0,
      reason: 'DAG_HEAD_MISMATCH',
      detail: `anchor chainHead ${anchor.chainHead} != merged chain head ${mergedHead}`,
    });
  }

  return { ok: breaks.length === 0, breaks };
}

export interface VerifyMergeAuditChainInput {
  /** Clone A's audit rows (chronological, as `findAllChronological` returns). */
  cloneARows: readonly AuditChainRow[];
  /** Clone B's audit rows (chronological). */
  cloneBRows: readonly AuditChainRow[];
  /** The merged DB's audit rows (the union both clones' rows were promoted into). */
  mergedRows: readonly AuditChainRow[];
  /** Path to the signed-merge-anchor log (bead 8da.7). */
  anchorPath: string;
}

/** Minimal repo shape `verifyAuditChain` needs - just the chronological read. */
function repoOf(rows: readonly AuditChainRow[]): Parameters<typeof verifyAuditChain>[0] {
  return {
    findAllChronological: () => [...rows],
  } as unknown as Parameters<typeof verifyAuditChain>[0];
}

/**
 * Verify a MERGE end-to-end: both clone chains in isolation, the re-derived
 * merged chain in the canonical id order, and the signed DAG anchor.
 *
 * The merged chain is re-walked over `canonicalMergeOrder(mergedRows)` - the
 * id-sorted order the verifier OWNS - so a clean `mergeGovern` output re-walks to
 * byte-identical hashes with zero breaks, while a reordered or tampered merge
 * surfaces a `PREV_LINK_MISMATCH` / `ENTRY_HASH_MISMATCH` in the merged chain.
 *
 * `ok` is true only when all four sub-checks are clean.
 */
export function verifyMergeAuditChain(input: VerifyMergeAuditChainInput): MergeAuditVerifyResult {
  // 1. Per-clone linear validation - each clone's own history, as written.
  const cloneA = verifyAuditChain(repoOf(input.cloneARows));
  const cloneB = verifyAuditChain(repoOf(input.cloneBRows));

  // 2 + 3. Canonical id-ordering + merged-chain re-walk. The verifier orders the
  //        union itself (does not trust the gate's sort) and re-walks it.
  const ordered = canonicalMergeOrder(input.mergedRows);
  const mergedChain = walkChain(ordered);

  // 4. Signed DAG anchor cross-check (parents == clone heads, signature valid,
  //    chainHead == merged head).
  const anchors = readSignedMergeAnchors(input.anchorPath);
  const latest = anchors.length > 0 ? anchors[anchors.length - 1] : undefined;
  const dagAnchor = verifyDagAnchor(
    latest,
    chainHeadOf(input.cloneARows),
    chainHeadOf(input.cloneBRows),
    chainHeadOf(ordered),
  );

  const ok =
    cloneA.breaks.length === 0 &&
    cloneB.breaks.length === 0 &&
    mergedChain.breaks.length === 0 &&
    dagAnchor.ok;

  return { cloneA, cloneB, mergedChain, dagAnchor, ok };
}
