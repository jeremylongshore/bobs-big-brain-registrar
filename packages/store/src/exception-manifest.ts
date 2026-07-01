/**
 * Byte-pinned audit-break exception manifest + 3-state break classifier
 * (bead `compile-then-govern-e06.2`; umbrella `#27`; risk `010-AT-RISK`
 * R1/R2/R7; decision `009-AT-DECR` D5).
 *
 * ## Why this exists
 *
 * The live governed brain carries ~155 audit-chain breaks that are NOT
 * tampering: they are an artifact of the v1→v2 hash-version migration
 * (see `audit-chain.ts`, migration 6). The council ratified CARRYING those
 * breaks with a documented exception and NEVER re-hashing them — v1 hashes
 * are the tamper record, rehashing would erase the evidence (009-AT-DECR D5).
 *
 * ## The laundering risk this module closes (R1)
 *
 * D5's first wording keyed the exception on an INDEX-RANGE or DATE window.
 * That is a laundering surface: an attacker who edits any row *inside that
 * window* still produces an "expected" break and gets silently whitelisted.
 *
 * So this manifest pins each exception by its EXACT per-row tuple — the
 * current stored `{entry_hash, prev_entry_hash, hash_version, seq}` — and the
 * classifier accepts a break as documented ONLY on a full BYTE-MATCH of that
 * tuple (plus id + reason). ANY drift (a stored hash changed, an id not in the
 * manifest, a reason that no longer matches) flips the break to a tamper
 * signature. An attacker who re-touches a documented row therefore flips it
 * BACK to tamper — no laundering.
 *
 * ## What this module is NOT (R7)
 *
 * It never forks the chain walk and never re-hashes anything. It is a pure
 * POST-PROCESSOR over `verifyAuditChain`'s output: it partitions the breaks
 * that walker already found. The frozen serialisers in `audit-chain.ts` are
 * untouched.
 *
 * ## TODO (R2 follow-on): anchor the manifest hash
 *
 * The immediate follow-on is to cross-reference `manifestHash` into the
 * append-only anchor log so the amnesty itself is externally tamper-evident
 * (an attacker can't swap in a wider manifest and re-point the tooling at it).
 * That is NOT done in this PR because `AnchorRecord`'s `anchorBodyJson` is a
 * FROZEN serialiser: adding a field would silently invalidate every stored
 * anchor. It must land as a new anchor record variant (or a sibling
 * `manifest-anchor.jsonl`), tracked as the e06.2 immediate follow-up — see the
 * PR body. The manifest is already self-verifying (`readManifest` re-checks the
 * whole-body hash + count-asserts), so it is not un-anchored today; the anchor
 * cross-ref adds external, offline-editor-proof evidence on top.
 *
 * @module exception-manifest
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { AuditChainBreak } from './audit-verify.js';

/** Reason codes that indicate TAMPERING (as opposed to a non-malicious fork). */
const TAMPER_REASONS: ReadonlySet<AuditChainBreak['reason']> = new Set([
  'ENTRY_HASH_MISMATCH',
  'PREV_LINK_MISMATCH',
  'PREV_LINK_AND_ENTRY_HASH_MISMATCH',
]);

/**
 * The current stored identity of one known-migration break row, pinned by its
 * EXACT tuple. This is the amnesty record: a break matching this tuple
 * byte-for-byte is a documented exception; any drift from it is tampering.
 */
export interface ExceptionManifestEntry {
  /** Audit row primary key. Names the exception uniquely. */
  id: string;
  /** The row's CURRENT stored `entry_hash` at manifest-generation time. */
  entryHash: string;
  /** The row's CURRENT stored `prev_entry_hash` (null for the first chained row). */
  prevEntryHash: string | null;
  /** The row's stored `hash_version` (1 = pre-migration v1 form, 2 = v2). */
  hashVersion: number;
  /** The row's monotonic write-order key. Part of the pinned identity. */
  seq: number;
  /**
   * The break reason this exception covers (a tamper-reason code). The
   * classifier requires the live break's reason to still match this — a
   * documented ENTRY_HASH_MISMATCH that later reads as PREV_LINK_MISMATCH is
   * drift, not the same exception.
   */
  reason: AuditChainBreak['reason'];
}

/**
 * A frozen, self-describing amnesty for a specific brain's known-migration
 * breaks. Its `manifestHash` is a SHA-256 over the canonical body, so the
 * manifest itself is tamper-evident: editing any entry (or the count) changes
 * the hash, and `readManifest` re-verifies + count-asserts on load.
 */
export interface ExceptionManifest {
  schemaVersion: 1;
  /** Optional brain identifier (a manifest is brain-specific data). */
  brainId?: string;
  /** ISO-8601 timestamp the manifest was generated. */
  generatedAt: string;
  /** Frozen count of entries. `readManifest` HARD-asserts entries.length === this (R2). */
  entryCount: number;
  /** The pinned exceptions. */
  entries: ExceptionManifestEntry[];
  /** SHA-256 hex over the canonical body (everything above, entries sorted). */
  manifestHash: string;
}

/** The canonical body over which `manifestHash` is computed — excludes the hash itself. */
export type ExceptionManifestBody = Omit<ExceptionManifest, 'manifestHash'>;

/**
 * Deterministic ordering of entries for hashing: by `seq` ascending, then by
 * `id` lexicographically as a stable tiebreak. Returns a NEW sorted array;
 * never mutates the input.
 */
function sortedEntries(entries: readonly ExceptionManifestEntry[]): ExceptionManifestEntry[] {
  return [...entries].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Serialise the manifest body to a stable JSON string with FIXED key order at
 * every level (like `canonicalRowJson` / `anchorBodyJson`). Entries are sorted
 * (seq, id) and each entry's keys are emitted in a hardcoded order, so the
 * output is byte-identical across runtimes for the same logical manifest.
 */
function manifestBodyJson(body: ExceptionManifestBody): string {
  return JSON.stringify({
    schemaVersion: body.schemaVersion,
    brainId: body.brainId ?? null,
    generatedAt: body.generatedAt,
    entryCount: body.entryCount,
    entries: sortedEntries(body.entries).map((e) => ({
      id: e.id,
      entryHash: e.entryHash,
      prevEntryHash: e.prevEntryHash,
      hashVersion: e.hashVersion,
      seq: e.seq,
      reason: e.reason,
    })),
  });
}

/**
 * Compute the SHA-256 hex digest identifying an exception manifest, over its
 * canonical body (entries sorted by seq then id, fixed key order, excluding
 * `manifestHash`).
 */
export function computeManifestHash(body: ExceptionManifestBody): string {
  return createHash('sha256').update(manifestBodyJson(body), 'utf8').digest('hex');
}

/** Thrown by `readManifest` when a manifest file is malformed or fails an integrity check. */
export class ExceptionManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExceptionManifestError';
  }
}

function isEntry(v: unknown): v is ExceptionManifestEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e['id'] === 'string' &&
    typeof e['entryHash'] === 'string' &&
    (e['prevEntryHash'] === null || typeof e['prevEntryHash'] === 'string') &&
    typeof e['hashVersion'] === 'number' &&
    typeof e['seq'] === 'number' &&
    (e['reason'] === 'ENTRY_HASH_MISMATCH' ||
      e['reason'] === 'PREV_LINK_MISMATCH' ||
      e['reason'] === 'PREV_LINK_AND_ENTRY_HASH_MISMATCH' ||
      e['reason'] === 'CHAIN_FORK')
  );
}

/**
 * Read + validate an exception manifest from a single-JSON file.
 *
 * File format: one JSON object per file (the `ExceptionManifest` shape).
 * (JSONL was considered; single-JSON is chosen so the count-assert and the
 * whole-body hash have one unambiguous canonicalisation — the file is small
 * and written once.)
 *
 * Integrity gates enforced on load (fail-closed):
 *  1. Structural validation of every field.
 *  2. **HARD count-assert (R2):** `entries.length === entryCount`, else throw.
 *     A tampered manifest that adds/drops an entry without fixing `entryCount`
 *     is rejected here before it can launder or hide a break.
 *  3. **manifestHash re-verification:** recompute over the canonical body and
 *     compare; a mismatch means the manifest itself was edited → throw.
 *
 * @throws ExceptionManifestError on any malformed/inconsistent manifest.
 */
export function readManifest(path: string): ExceptionManifest {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ExceptionManifestError(`cannot read manifest at ${path}: ${String(e)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ExceptionManifestError(`manifest at ${path} is not valid JSON: ${String(e)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ExceptionManifestError(`manifest at ${path} is not a JSON object`);
  }
  const m = parsed as Record<string, unknown>;

  if (m['schemaVersion'] !== 1) {
    throw new ExceptionManifestError(
      `manifest at ${path}: unsupported schemaVersion ${String(m['schemaVersion'])} (expected 1)`,
    );
  }
  if (typeof m['generatedAt'] !== 'string') {
    throw new ExceptionManifestError(`manifest at ${path}: generatedAt must be a string`);
  }
  if (typeof m['entryCount'] !== 'number') {
    throw new ExceptionManifestError(`manifest at ${path}: entryCount must be a number`);
  }
  if (typeof m['manifestHash'] !== 'string') {
    throw new ExceptionManifestError(`manifest at ${path}: manifestHash must be a string`);
  }
  if (m['brainId'] !== undefined && typeof m['brainId'] !== 'string') {
    throw new ExceptionManifestError(`manifest at ${path}: brainId must be a string when present`);
  }
  if (!Array.isArray(m['entries']) || !m['entries'].every(isEntry)) {
    throw new ExceptionManifestError(
      `manifest at ${path}: entries must be an array of valid entries`,
    );
  }

  const entries = m['entries'] as ExceptionManifestEntry[];
  const entryCount = m['entryCount'];

  // (R2) Freeze the entry count: a count that disagrees with the array length
  // is a tampered manifest — refuse it. This is a HARD assert, not a warning.
  if (entries.length !== entryCount) {
    throw new ExceptionManifestError(
      `manifest at ${path}: entryCount ${entryCount} != entries.length ${entries.length} ` +
        `(count drift / tampered manifest)`,
    );
  }

  const body: ExceptionManifestBody = {
    schemaVersion: 1,
    ...(m['brainId'] !== undefined ? { brainId: m['brainId'] as string } : {}),
    generatedAt: m['generatedAt'],
    entryCount,
    entries,
  };
  const recomputed = computeManifestHash(body);
  if (recomputed !== m['manifestHash']) {
    throw new ExceptionManifestError(
      `manifest at ${path}: manifestHash mismatch (recomputed ${recomputed} != stored ` +
        `${String(m['manifestHash'])}) — manifest content was edited`,
    );
  }

  return { ...body, manifestHash: m['manifestHash'] };
}

/**
 * The CURRENT stored tuple of an audit row, keyed by id. The classifier reads
 * from this map (the live DB right now) — NOT from the manifest — so it can
 * detect drift between what the manifest recorded and what the row holds today.
 */
export interface StoredRowTuple {
  entry_hash: string | null;
  prev_entry_hash: string | null;
  hash_version: number;
  seq: number;
}

/** The 3-state partition of the audit-chain breaks. */
export interface ClassifiedChainBreaks {
  /**
   * True iff the brain is clean: NO tamper signatures AND NO chain forks.
   * Documented exceptions do NOT fail verification; a fork means not-pristine.
   */
  verified: boolean;
  /** Known-migration breaks that byte-match the manifest — carried, not failed. */
  documentedExceptions: AuditChainBreak[];
  /** Tamper signatures: any tamper-reason break not fully covered by the manifest. */
  tamperSignatures: AuditChainBreak[];
  /** Non-tamper ordering forks — surfaced separately, never silently greened. */
  chainForks: AuditChainBreak[];
}

/**
 * Partition the breaks `verifyAuditChain` found into documented exceptions,
 * tamper signatures, and chain forks. A pure post-processor: it reads breaks +
 * the manifest + the live DB's current row tuples, and mutates nothing.
 *
 * ### Rules (the security core — R1)
 *
 * - `reason === 'CHAIN_FORK'` → **chainForks**. A fork is not tampering, but it
 *   is NOT auto-verified either: it is kept separate and counts against a clean
 *   brain. (A documented exception whose reason is CHAIN_FORK is impossible —
 *   the manifest only pins tamper-reason breaks — so a manifest-listed
 *   CHAIN_FORK id has no effect: the reason branch wins first.)
 *
 * - A tamper-reason break is a **documentedException** ONLY IF ALL hold:
 *     1. its `id` is present in the manifest, AND
 *     2. the row's CURRENT stored `{entry_hash, prev_entry_hash, hash_version,
 *        seq}` (from `rowsById`, i.e. what the DB holds right now) BYTE-EQUALS
 *        the manifest entry's recorded tuple, AND
 *     3. the live break's `reason` still equals the manifest entry's `reason`.
 *   ANY drift — a stored hash changed, the id is absent, or the reason moved —
 *   makes it a **tamperSignature**. This is the whole point: re-touching a
 *   documented row flips it back to tamper (no laundering).
 *
 * - `verified === (tamperSignatures.length === 0 && chainForks.length === 0)`.
 *
 * @param breaks    The `breaks` array from a `verifyAuditChain` result.
 * @param manifest  The loaded exception manifest, or `null` (no amnesty → every
 *                  tamper-reason break is a tamperSignature).
 * @param rowsById  Map of audit row id → its CURRENT stored tuple (from the DB).
 */
export function classifyChainBreaks(
  breaks: readonly AuditChainBreak[],
  manifest: ExceptionManifest | null,
  rowsById: ReadonlyMap<string, StoredRowTuple>,
): ClassifiedChainBreaks {
  // Index the manifest by id for O(1) byte-match lookup. A given row id appears
  // at most once in a well-formed manifest; if a duplicate id somehow slipped
  // past readManifest, the LAST one wins here — but the byte-match still has to
  // pass, so a duplicate cannot broaden the amnesty.
  const manifestById = new Map<string, ExceptionManifestEntry>();
  if (manifest) {
    for (const e of manifest.entries) manifestById.set(e.id, e);
  }

  const documentedExceptions: AuditChainBreak[] = [];
  const tamperSignatures: AuditChainBreak[] = [];
  const chainForks: AuditChainBreak[] = [];

  for (const brk of breaks) {
    // A fork is never tampering and never a documented exception — it is its
    // own bucket. Decide this FIRST so a manifest-listed id can't reclassify it.
    if (brk.reason === 'CHAIN_FORK') {
      chainForks.push(brk);
      continue;
    }

    // From here down, brk.reason is a tamper-reason code.
    const entry = manifestById.get(brk.id);
    const stored = rowsById.get(brk.id);

    const isDocumented =
      entry !== undefined &&
      stored !== undefined &&
      // Byte-match the CURRENT stored tuple against the pinned tuple.
      stored.entry_hash === entry.entryHash &&
      stored.prev_entry_hash === entry.prevEntryHash &&
      stored.hash_version === entry.hashVersion &&
      stored.seq === entry.seq &&
      // …and the break reason must still be the one the exception was minted for.
      entry.reason === brk.reason &&
      // Defence-in-depth: a manifest may only ever carry tamper-reason
      // exceptions. If a CHAIN_FORK somehow got pinned, refuse to honour it.
      TAMPER_REASONS.has(entry.reason);

    if (isDocumented) {
      documentedExceptions.push(brk);
    } else {
      tamperSignatures.push(brk);
    }
  }

  return {
    verified: tamperSignatures.length === 0 && chainForks.length === 0,
    documentedExceptions,
    tamperSignatures,
    chainForks,
  };
}
