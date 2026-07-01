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

import { z } from 'zod';

import type { AuditChainBreak } from './audit-verify.js';

/**
 * The THREE tamper-reason codes — the only reasons a manifest entry may carry.
 * A `CHAIN_FORK` is a non-malicious ordering artifact and is NEVER pinned as a
 * documented exception, so it is deliberately EXCLUDED from the manifest-entry
 * reason enum (a manifest listing a fork reason is rejected on load).
 */
const TAMPER_REASONS = [
  'ENTRY_HASH_MISMATCH',
  'PREV_LINK_MISMATCH',
  'PREV_LINK_AND_ENTRY_HASH_MISMATCH',
] as const;

/** A tamper-reason code (the subset of `AuditChainBreak['reason']` a manifest may pin). */
export type TamperReason = (typeof TAMPER_REASONS)[number];

/** Set form of the tamper reasons for O(1) defence-in-depth membership checks. */
const TAMPER_REASON_SET: ReadonlySet<AuditChainBreak['reason']> = new Set(TAMPER_REASONS);

/**
 * Zod schema for one pinned exception (repo convention: Zod is the source of
 * truth for on-disk shapes). Note `entryHash` is NULLABLE — a tamper-reason
 * break can have a NULL stored `entry_hash` (`AuditChainBreak.actualEntryHash`
 * is `string | null`), e.g. a row whose hash column was cleared. The pin must
 * capture that null accurately so a later null→value drift reads as tamper.
 * `reason` is restricted to the three tamper reasons ONLY.
 */
export const ExceptionManifestEntrySchema = z.object({
  /** Audit row primary key. Names the exception uniquely. */
  id: z.string(),
  /** The row's CURRENT stored `entry_hash` at manifest-generation time (nullable). */
  entryHash: z.string().nullable(),
  /** The row's CURRENT stored `prev_entry_hash` (null for the first chained row). */
  prevEntryHash: z.string().nullable(),
  /** The row's stored `hash_version` (1 = pre-migration v1 form, 2 = v2). */
  hashVersion: z.number(),
  /** The row's monotonic write-order key. Part of the pinned identity. */
  seq: z.number(),
  /**
   * The tamper reason this exception covers. The classifier requires the live
   * break's reason to still match this — a documented ENTRY_HASH_MISMATCH that
   * later reads as PREV_LINK_MISMATCH is drift, not the same exception.
   * CHAIN_FORK is intentionally NOT a permitted value.
   */
  reason: z.enum(TAMPER_REASONS),
});

/**
 * The current stored identity of one known-migration break row, pinned by its
 * EXACT tuple. This is the amnesty record: a break matching this tuple
 * byte-for-byte is a documented exception; any drift from it is tampering.
 */
export type ExceptionManifestEntry = z.infer<typeof ExceptionManifestEntrySchema>;

/**
 * Zod schema for the manifest as it appears ON DISK. `brainId` is NULLABLE and
 * OPTIONAL — it serialises as `null` in the canonical body when omitted, and
 * the loader must accept an explicit `null`. This schema validates STRUCTURE
 * only; the R2 count-assert and the `manifestHash` re-verify are additional
 * gates applied in `readManifest` (they cross-reference fields, not shape).
 */
export const ExceptionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  /** Optional brain identifier (a manifest is brain-specific data); null when absent. */
  brainId: z.string().nullable().optional(),
  /** ISO-8601 timestamp the manifest was generated. */
  generatedAt: z.string(),
  /** Frozen count of entries. `readManifest` HARD-asserts entries.length === this (R2). */
  entryCount: z.number(),
  /** The pinned exceptions. */
  entries: z.array(ExceptionManifestEntrySchema),
  /** SHA-256 hex over the canonical body (everything above, entries sorted). */
  manifestHash: z.string(),
});

/**
 * A frozen, self-describing amnesty for a specific brain's known-migration
 * breaks. Its `manifestHash` is a SHA-256 over the canonical body, so the
 * manifest itself is tamper-evident: editing any entry (or the count) changes
 * the hash, and `readManifest` re-verifies + count-asserts on load.
 */
export type ExceptionManifest = z.infer<typeof ExceptionManifestSchema>;

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

/**
 * Read + validate an exception manifest from a single-JSON file.
 *
 * File format: one JSON object per file (the `ExceptionManifest` shape).
 * (JSONL was considered; single-JSON is chosen so the count-assert and the
 * whole-body hash have one unambiguous canonicalisation — the file is small
 * and written once.)
 *
 * Integrity gates enforced on load (fail-closed):
 *  1. **Structural validation via `ExceptionManifestSchema` (Zod).** Rejects
 *     any malformed field and any entry whose `reason` is not one of the three
 *     tamper reasons — a manifest listing `CHAIN_FORK` is refused here.
 *  2. **HARD count-assert (R2):** `entries.length === entryCount`, else throw.
 *     A tampered manifest that adds/drops an entry without fixing `entryCount`
 *     is rejected before it can launder or hide a break.
 *  3. **manifestHash re-verification:** recompute over the canonical body and
 *     compare; a mismatch means the manifest itself was edited → throw.
 *
 * Gates 2 and 3 are cross-field checks (they compare `entryCount`/`manifestHash`
 * against derived values), so they live here rather than in the Zod shape.
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

  // (1) Structural validation — Zod is the source of truth for the shape.
  const result = ExceptionManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
    throw new ExceptionManifestError(
      `manifest at ${path} failed schema validation: ${issues.join('; ')}`,
    );
  }
  const m = result.data;

  // (2) (R2) Freeze the entry count: a count that disagrees with the array
  // length is a tampered manifest — refuse it. HARD assert, not a warning.
  if (m.entries.length !== m.entryCount) {
    throw new ExceptionManifestError(
      `manifest at ${path}: entryCount ${m.entryCount} != entries.length ${m.entries.length} ` +
        `(count drift / tampered manifest)`,
    );
  }

  // (3) manifestHash re-verification over the canonical body.
  const body: ExceptionManifestBody = {
    schemaVersion: 1,
    ...(m.brainId !== undefined && m.brainId !== null ? { brainId: m.brainId } : {}),
    generatedAt: m.generatedAt,
    entryCount: m.entryCount,
    entries: m.entries,
  };
  const recomputed = computeManifestHash(body);
  if (recomputed !== m.manifestHash) {
    throw new ExceptionManifestError(
      `manifest at ${path}: manifestHash mismatch (recomputed ${recomputed} != stored ` +
        `${m.manifestHash}) — manifest content was edited`,
    );
  }

  return { ...body, manifestHash: m.manifestHash };
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
      // Byte-match the CURRENT stored tuple against the pinned tuple. `===` is
      // null-aware: a null pin matches a null stored hash, and a null→value (or
      // value→null) drift is unequal, so it correctly falls through to tamper.
      stored.entry_hash === entry.entryHash &&
      stored.prev_entry_hash === entry.prevEntryHash &&
      stored.hash_version === entry.hashVersion &&
      stored.seq === entry.seq &&
      // …and the break reason must still be the one the exception was minted for.
      entry.reason === brk.reason &&
      // Defence-in-depth: a manifest may only ever carry tamper-reason
      // exceptions (the Zod enum already excludes CHAIN_FORK). If a fork reason
      // somehow got pinned, refuse to honour it.
      TAMPER_REASON_SET.has(entry.reason);

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
