/**
 * External anchoring for the audit hash chain.
 *
 * `verifyAuditChain` proves the chain is *internally* consistent — but it
 * re-anchors on each row's stored `entry_hash`, so a writer with local access
 * who edits an early event AND re-hashes every later row forward produces a
 * chain that still verifies clean. That is tamper-DETECTION of accidental or
 * partial edits, not protection against a deliberate full rewrite.
 *
 * This module closes that gap by periodically snapshotting the chain head into
 * an **append-only, hash-chained anchor log** (a JSONL file). Each anchor records
 * the number of chained rows and the head `entry_hash` at that moment, linked to
 * the previous anchor by `prevAnchorHash` (so the anchor log is itself a hash
 * chain). `verifyAnchors` then cross-checks the *current* chain against every
 * anchored snapshot: if history before an anchored position was rewritten, the
 * recomputed head no longer matches the value frozen in the anchor — a
 * `HISTORY_REWRITTEN` break that `verifyAuditChain` alone cannot see.
 *
 * The anchor log becomes externally tamper-EVIDENT only when committed somewhere
 * an offline editor cannot quietly rewrite — e.g. `git commit` + push of the
 * anchor file (git's own content-addressed history on a remote), or an
 * OpenTimestamps proof of the latest `anchorHash`. This module owns the log +
 * verification; the caller owns the external commit. Trust model: local =
 * integrity + ordering + rewrite-detection-since-last-anchor; cross-actor
 * non-repudiation still requires the external commit + per-actor signatures.
 *
 * @module audit-anchor
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import { verifyAuditChain, type AuditVerifyResult } from './audit-verify.js';
import type { AuditRepository, AuditChainRow } from './repositories/audit-repository.js';

/** One snapshot of the audit chain head, linked into an append-only log. */
export interface AnchorRecord {
  schemaVersion: 1;
  /** ISO-8601 timestamp the anchor was taken. */
  anchoredAt: string;
  tenantId: string;
  /** Number of CHAINED rows (entry_hash != null) at anchor time. */
  chainedRows: number;
  /** The head row's entry_hash (empty string when there were no chained rows). */
  chainHead: string;
  /** anchorHash of the previous anchor in the log (null for the first). */
  prevAnchorHash: string | null;
  /** sha256 over the canonical body (everything above) — this record's identity. */
  anchorHash: string;
}

type AnchorBody = Omit<AnchorRecord, 'anchorHash'>;

/** Canonical body serialisation — fixed key order, like canonicalRowJson. */
function anchorBodyJson(b: AnchorBody): string {
  return JSON.stringify({
    schemaVersion: b.schemaVersion,
    anchoredAt: b.anchoredAt,
    tenantId: b.tenantId,
    chainedRows: b.chainedRows,
    chainHead: b.chainHead,
    prevAnchorHash: b.prevAnchorHash,
  });
}

/** SHA-256 hex digest identifying an anchor record (over its canonical body). */
export function computeAnchorHash(body: AnchorBody): string {
  return createHash('sha256').update(anchorBodyJson(body), 'utf8').digest('hex');
}

function chainedRowsOf(repo: AuditRepository): AuditChainRow[] {
  return repo.findAllChronological().filter((r) => r.entry_hash !== null);
}

/** Parse the append-only anchor log. Returns [] when the file is absent. */
export function readAnchors(anchorPath: string): AnchorRecord[] {
  if (!existsSync(anchorPath)) return [];
  return readFileSync(anchorPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AnchorRecord);
}

export interface AppendAnchorOptions {
  tenantId: string;
  /** Injectable clock for deterministic tests. */
  nowFn?: () => string;
}

/**
 * Snapshot the current chain head and append it to the anchor log. The new
 * record links to the prior one by `prevAnchorHash`, extending the anchor-log
 * hash chain. Returns the record written.
 *
 * After calling this, commit the anchor file externally (git push / OTS) to
 * make the snapshot tamper-EVIDENT against a later local rewrite.
 */
export function appendAnchor(
  repo: AuditRepository,
  anchorPath: string,
  opts: AppendAnchorOptions,
): AnchorRecord {
  const now = opts.nowFn ?? (() => new Date().toISOString());
  const rows = chainedRowsOf(repo);
  const head = rows.length > 0 ? (rows[rows.length - 1]!.entry_hash ?? '') : '';
  const existing = readAnchors(anchorPath);
  const prevAnchorHash = existing.length > 0 ? existing[existing.length - 1]!.anchorHash : null;

  const body: AnchorBody = {
    schemaVersion: 1,
    anchoredAt: now(),
    tenantId: opts.tenantId,
    chainedRows: rows.length,
    chainHead: head,
    prevAnchorHash,
  };
  const record: AnchorRecord = { ...body, anchorHash: computeAnchorHash(body) };
  appendFileSync(anchorPath, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

/** A discrepancy between the live chain and the anchored snapshots, or within the log. */
export interface AnchorBreak {
  /** Zero-indexed position in the anchor log. */
  index: number;
  anchoredAt: string;
  reason:
    | 'ANCHOR_HASH_MISMATCH' // an anchor record itself was edited
    | 'ANCHOR_LINK_MISMATCH' // the anchor log was reordered / spliced
    | 'HISTORY_TRUNCATED' // chain now has fewer rows than were anchored
    | 'HISTORY_REWRITTEN'; // the head at an anchored position changed — the rewrite verifyAuditChain misses
  detail: string;
}

export interface AnchorVerifyResult {
  /** The underlying intra-chain verification. */
  chain: AuditVerifyResult;
  anchorCount: number;
  anchorBreaks: AnchorBreak[];
  /** True iff the chain is internally clean AND consistent with every anchor. */
  ok: boolean;
}

/**
 * Verify the audit chain against its anchor log. Detects (a) anchor records
 * that were edited, (b) a reordered/spliced anchor log, and — crucially — (c) a
 * silent full rewrite of history before any anchored position, which
 * `verifyAuditChain` cannot detect on its own. Never throws on tamper.
 */
export function verifyAnchors(repo: AuditRepository, anchorPath: string): AnchorVerifyResult {
  const chain = verifyAuditChain(repo);
  const anchors = readAnchors(anchorPath);
  const rows = chainedRowsOf(repo);
  const anchorBreaks: AnchorBreak[] = [];

  let expectedPrev: string | null = null;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;

    const recomputed = computeAnchorHash({
      schemaVersion: a.schemaVersion,
      anchoredAt: a.anchoredAt,
      tenantId: a.tenantId,
      chainedRows: a.chainedRows,
      chainHead: a.chainHead,
      prevAnchorHash: a.prevAnchorHash,
    });
    if (recomputed !== a.anchorHash) {
      anchorBreaks.push({
        index: i,
        anchoredAt: a.anchoredAt,
        reason: 'ANCHOR_HASH_MISMATCH',
        detail: 'anchor record content does not match its anchorHash',
      });
    }
    if (a.prevAnchorHash !== expectedPrev) {
      anchorBreaks.push({
        index: i,
        anchoredAt: a.anchoredAt,
        reason: 'ANCHOR_LINK_MISMATCH',
        detail: `prevAnchorHash ${a.prevAnchorHash ?? 'null'} != expected ${expectedPrev ?? 'null'}`,
      });
    }
    expectedPrev = a.anchorHash;

    if (rows.length < a.chainedRows) {
      anchorBreaks.push({
        index: i,
        anchoredAt: a.anchoredAt,
        reason: 'HISTORY_TRUNCATED',
        detail: `anchored ${a.chainedRows} chained rows; chain now has ${rows.length}`,
      });
    } else if (a.chainedRows > 0) {
      const actualHead = rows[a.chainedRows - 1]!.entry_hash;
      if (actualHead !== a.chainHead) {
        anchorBreaks.push({
          index: i,
          anchoredAt: a.anchoredAt,
          reason: 'HISTORY_REWRITTEN',
          detail: `row ${a.chainedRows} head ${actualHead ?? 'null'} != anchored ${a.chainHead}`,
        });
      }
    }
  }

  return {
    chain,
    anchorCount: anchors.length,
    anchorBreaks,
    ok: chain.breaks.length === 0 && anchorBreaks.length === 0,
  };
}
