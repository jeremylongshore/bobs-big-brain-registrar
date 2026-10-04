/**
 * provenance-walk — walk one curated memory's full provenance chain across the
 * govern/compile boundary and report PASS / FAIL / UNVERIFIABLE per link.
 *
 * The two hash chains prove DIFFERENT things (046-AT-ARCH): the ICO trace
 * chain (`<brain>/audit/traces/*.jsonl`) evidences that a compile pass ran;
 * the INTKB `audit_events` chain evidences that a candidate was admitted by
 * the deterministic policy pipeline. Neither proves the other's claims. The
 * bridge between them is (a) the spool manifest sidecar's SHA-256 +
 * candidateIds and (b) the shared UUID-v5 content-addressed id lineage
 * (`packages/common/src/uuid-v5.ts`). This walker makes that bridge
 * inspectable for a single memory:
 *
 *   memory_id
 *     -> curated_memories row                              (govern store)
 *     -> id == deriveMemoryId(candidate_id, content_hash)  (id lineage)
 *     -> 'promoted' audit receipt                          (govern chain)
 *     -> candidates row                                    (govern store)
 *     -> candidate_id == deriveCandidateId(ws, relPath, sha256(content))
 *     -> spool manifest entry (candidateIds + file SHA-256) (the bridge)
 *     -> ICO compile trace event referencing relPath        (compile chain)
 *
 * Honesty discipline: a link whose backing artifact is ABSENT (no brain dir on
 * CI, an mcp-captured candidate that never had a spool file, rotated traces)
 * is reported UNVERIFIABLE — not PASS, not FAIL. FAIL is reserved for
 * contradiction: an artifact that exists and disagrees.
 *
 * @module provenance/provenance-walk
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { computeContentHash, deriveCandidateId, deriveMemoryId } from '@qmd-team-intent-kb/common';
import type { createDatabase as CreateDatabase } from '@qmd-team-intent-kb/store';

type Db = ReturnType<typeof CreateDatabase>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Verdict for one link of the chain. */
export type LinkStatus = 'PASS' | 'FAIL' | 'UNVERIFIABLE';

/** Stable link names, in walk order. */
export type LinkName =
  | 'memory-row'
  | 'memory-id-derivation'
  | 'promotion-receipt'
  | 'candidate-row'
  | 'candidate-id-derivation'
  | 'spool-manifest'
  | 'compile-trace';

export interface WalkLink {
  link: LinkName;
  status: LinkStatus;
  /** Human-readable statement of what evidence backs (or fails to back) the link. */
  evidence: string;
}

export interface WalkResult {
  memoryId: string;
  links: WalkLink[];
  passCount: number;
  failCount: number;
  unverifiableCount: number;
  /** 0 = every link PASS · 1 = >=1 FAIL (broken chain) · 3 = no FAIL but >=1 UNVERIFIABLE. */
  exitCode: 0 | 1 | 3;
}

export interface WalkOptions {
  /** Directories scanned (recursively) for `*.manifest.json` spool sidecars. */
  spoolDirs: string[];
  /** ICO brain root (contains `audit/traces/`). Its basename is the workspaceId
   *  ICO folded into the candidate's UUID-v5 derivation. */
  brainDir: string;
}

// ---------------------------------------------------------------------------
// Row shapes (raw SQL — the walker is read-only and repo-independent)
// ---------------------------------------------------------------------------

interface MemoryRow {
  id: string;
  candidate_id: string;
  content: string;
  content_hash: string;
  tenant_id: string;
  source: string;
  promoted_at: string;
}

interface CandidateRow {
  id: string;
  source: string;
  content: string;
  content_hash: string;
  metadata_json: string;
}

interface ReceiptRow {
  id: string;
  timestamp: string;
}

interface SpoolManifest {
  spoolFile?: string;
  spoolFileSha256?: string;
  candidateIds?: string[];
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Recursively collect `*.manifest.json` files under a directory (best-effort:
 *  unreadable entries are skipped, never fatal). */
function collectManifestFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectManifestFiles(full, out);
    } else if (entry.endsWith('.manifest.json')) {
      out.push(full);
    }
  }
  return out;
}

/** Parse one manifest sidecar; null on malformed JSON (skipped, not fatal). */
function readManifest(path: string): SpoolManifest | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SpoolManifest;
  } catch {
    return null;
  }
}

/** Minimal shape of one ICO trace event (daily JSONL under audit/traces/). */
interface TraceEvent {
  event_type?: string;
  event_id?: string;
  timestamp?: string;
  prev_hash?: string | null;
  payload?: { outputPath?: string };
}

/** Scan every daily trace file for the first event whose payload.outputPath
 *  matches `relPath`. Returns the match + its file, or null. */
function findTraceEvent(
  tracesDir: string,
  relPath: string,
): { file: string; event: TraceEvent } | null {
  let files: string[];
  try {
    files = readdirSync(tracesDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  } catch {
    return null;
  }
  for (const f of files) {
    const full = join(tracesDir, f);
    let body: string;
    try {
      body = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const line of body.split('\n')) {
      if (line.trim() === '') continue;
      // Cheap prefilter before JSON.parse — trace files can be large.
      if (!line.includes(relPath)) continue;
      let ev: TraceEvent;
      try {
        ev = JSON.parse(line) as TraceEvent;
      } catch {
        continue;
      }
      if (ev.payload?.outputPath === relPath) {
        return { file: full, event: ev };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Governed-redaction trail (K3)
// ---------------------------------------------------------------------------

/**
 * The content-hash history a row's `redacted` receipts record. A governed
 * redaction replaces a row's content and so its content hash, but the row keeps
 * the id it was given at promotion (or capture) — an id derived from the
 * ORIGINAL hash. The receipts carry each old/new hash pair, so the derivation
 * can still be checked without the removed text.
 */
interface RedactionTrail {
  /** The hash before the first redaction: what the id was derived from. */
  originalHash: string;
  /** Receipt ids, in chain order. */
  receiptIds: string[];
  /** True when each receipt's old hash is the previous one's new hash and the
   *  last new hash is the row's current content hash. */
  consistent: boolean;
}

/** Read a row's redaction trail from the audit chain; null when it has none. */
function readRedactionTrail(db: Db, targetId: string, currentHash: string): RedactionTrail | null {
  const rows = db
    .prepare(
      `SELECT id, details_json FROM audit_events
       WHERE memory_id = ? AND action = 'redacted'
       ORDER BY seq ASC`,
    )
    .all(targetId) as Array<{ id: string; details_json: string }>;
  const pairs: Array<{ id: string; oldHash: string; newHash: string }> = [];
  for (const row of rows) {
    try {
      const details = JSON.parse(row.details_json) as Record<string, unknown>;
      const oldHash = details['oldContentHash'];
      const newHash = details['newContentHash'];
      if (typeof oldHash === 'string' && typeof newHash === 'string') {
        pairs.push({ id: row.id, oldHash, newHash });
      }
    } catch {
      // A malformed receipt contributes nothing; the trail is then inconsistent
      // or absent, and the link reports FAIL on the plain derivation.
    }
  }
  if (pairs.length === 0) return null;
  let consistent = pairs[pairs.length - 1]!.newHash === currentHash;
  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i]!.oldHash !== pairs[i - 1]!.newHash) consistent = false;
  }
  return { originalHash: pairs[0]!.oldHash, receiptIds: pairs.map((p) => p.id), consistent };
}

/** One link's verdict, before it is named and pushed. */
interface LinkVerdict {
  status: LinkStatus;
  evidence: string;
}

/**
 * Link 2: the memory id is content-derived from its candidate lineage
 * (`deriveMemoryId`, packages/common/src/uuid-v5.ts), and the stored content
 * still hashes to the stored content_hash.
 *
 * A governed redaction (K3) replaces the content, so the id — derived at
 * promotion from the ORIGINAL hash — no longer matches the current one. The
 * 'redacted' receipts record the hash history; the id is verified against that.
 */
function memoryIdDerivationLink(db: Db, memory: MemoryRow): LinkVerdict {
  const recomputedHash = computeContentHash(memory.content);
  if (recomputedHash !== memory.content_hash) {
    return {
      status: 'FAIL',
      evidence: `stored content no longer hashes to content_hash (expected ${memory.content_hash}, got ${recomputedHash}) — the durable row was modified after promotion`,
    };
  }
  const derivedMemoryId = deriveMemoryId(memory.candidate_id, memory.content_hash);
  if (derivedMemoryId === memory.id) {
    return {
      status: 'PASS',
      evidence: `id == uuidv5("memory", candidate_id, content_hash) == ${derivedMemoryId}; content re-hashes to content_hash`,
    };
  }
  const trail = readRedactionTrail(db, memory.id, memory.content_hash);
  if (trail === null) {
    return {
      status: 'FAIL',
      evidence: `id ${memory.id} != derived ${derivedMemoryId} — the id is not a pure function of this candidate lineage (pre-derivation legacy row, or the lineage was altered)`,
    };
  }
  const count = trail.receiptIds.length;
  if (trail.consistent && deriveMemoryId(memory.candidate_id, trail.originalHash) === memory.id) {
    return {
      status: 'PASS',
      evidence: `id == uuidv5("memory", candidate_id, pre-redaction content_hash) — the content was governed-redacted ${count} time(s); 'redacted' receipt(s) ${trail.receiptIds.join(', ')} record the hash history ending at the current content_hash; content re-hashes to content_hash`,
    };
  }
  const why = trail.consistent
    ? 'is consistent but its starting hash does not derive this id'
    : 'does not end at the current content_hash';
  return {
    status: 'FAIL',
    evidence: `id ${memory.id} does not derive from the current content_hash, and its ${count} 'redacted' receipt(s) do not account for it (hash history ${why}) — the row was changed outside a governed redaction`,
  };
}

/**
 * Link 5: the candidate id is content-addressed. ICO derives it as
 * uuidv5(workspaceId, relPath, bodySha256) where bodySha256 is the SHA-256 of
 * the compiled page body — exactly the candidate content INTKB stored.
 * workspaceId is the basename of the brain root (ICO kernel spool.ts).
 *
 * The candidate copy of a governed-redacted memory (K3) was rewritten too; its
 * 'redacted' receipt records the hash the id was addressed by.
 */
function candidateIdDerivationLink(
  db: Db,
  candidate: CandidateRow,
  workspaceId: string,
  relPath: string,
): LinkVerdict {
  const bodySha256 = computeContentHash(candidate.content);
  const derivedCandidateId = deriveCandidateId(workspaceId, relPath, bodySha256);
  if (derivedCandidateId === candidate.id) {
    return {
      status: 'PASS',
      evidence: `candidate_id == uuidv5(workspaceId="${workspaceId}", relPath="${relPath}", sha256(content)) == ${derivedCandidateId}`,
    };
  }
  const trail = readRedactionTrail(db, candidate.id, bodySha256);
  if (
    trail !== null &&
    trail.consistent &&
    deriveCandidateId(workspaceId, relPath, trail.originalHash) === candidate.id
  ) {
    return {
      status: 'PASS',
      evidence: `candidate_id == uuidv5(workspaceId="${workspaceId}", relPath="${relPath}", pre-redaction sha256(content)) — the candidate copy was governed-redacted; 'redacted' receipt(s) ${trail.receiptIds.join(', ')} record the hash history`,
    };
  }
  return {
    status: 'FAIL',
    evidence: `candidate_id ${candidate.id} != derived ${derivedCandidateId} (workspaceId="${workspaceId}", relPath="${relPath}") — stored candidate content does not address to this id`,
  };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Walk the provenance chain for one memory id. Read-only over `db` and the
 * filesystem; never throws for absent artifacts (that is what UNVERIFIABLE
 * is for).
 */
export function walkProvenance(db: Db, memoryId: string, opts: WalkOptions): WalkResult {
  const links: WalkLink[] = [];
  const push = (link: LinkName, status: LinkStatus, evidence: string): void => {
    links.push({ link, status, evidence });
  };

  // Link 1 — the curated_memories row itself.
  const memory = db
    .prepare(
      `SELECT id, candidate_id, content, content_hash, tenant_id, source, promoted_at
       FROM curated_memories WHERE id = ?`,
    )
    .get(memoryId) as MemoryRow | undefined;

  if (memory === undefined) {
    push('memory-row', 'FAIL', `no curated_memories row with id ${memoryId}`);
    return finalize(memoryId, links);
  }
  push(
    'memory-row',
    'PASS',
    `curated_memories row found (tenant=${memory.tenant_id}, source=${memory.source}, promoted_at=${memory.promoted_at})`,
  );

  // Link 2 — the memory id is content-derived from its candidate lineage.
  const memoryIdLink = memoryIdDerivationLink(db, memory);
  push('memory-id-derivation', memoryIdLink.status, memoryIdLink.evidence);

  // Link 3 — the govern-side receipt: the audit_events chain must carry the
  // row-creating 'promoted' event for this memory (the admission receipt).
  const receipt = db
    .prepare(
      `SELECT id, timestamp FROM audit_events
       WHERE memory_id = ? AND action = 'promoted'
       ORDER BY timestamp LIMIT 1`,
    )
    .get(memoryId) as ReceiptRow | undefined;
  if (receipt === undefined) {
    push(
      'promotion-receipt',
      'FAIL',
      `no 'promoted' audit_events receipt for this memory — the signature of an insert that bypassed the promoter (see verify-corpus-accounting)`,
    );
  } else {
    push(
      'promotion-receipt',
      'PASS',
      `'promoted' receipt ${receipt.id} at ${receipt.timestamp} on the audit_events hash chain (verify the whole chain with verify-audit-chain)`,
    );
  }

  // Link 4 — the candidate row the memory claims descent from.
  const candidate = db
    .prepare(
      `SELECT id, source, content, content_hash, metadata_json
       FROM candidates WHERE id = ?`,
    )
    .get(memory.candidate_id) as CandidateRow | undefined;
  if (candidate === undefined) {
    push('candidate-row', 'FAIL', `no candidates row with id ${memory.candidate_id}`);
    return finalize(memoryId, links);
  }
  push(
    'candidate-row',
    'PASS',
    `candidates row found (id=${candidate.id}, source=${candidate.source})`,
  );

  // relPath: the compile-side source path ICO stamped into the candidate
  // metadata (buildCandidate sets filePaths[0] = the wiki page's relPath).
  let relPath: string | undefined;
  try {
    const meta = JSON.parse(candidate.metadata_json) as { filePaths?: string[] };
    relPath = Array.isArray(meta.filePaths) ? meta.filePaths[0] : undefined;
  } catch {
    relPath = undefined;
  }
  const spoolDerived = candidate.source === 'import' && relPath !== undefined;

  // Link 5 — the candidate id is content-addressed: ICO derives it as
  // uuidv5(workspaceId, relPath, bodySha256) where bodySha256 is the SHA-256
  // of the compiled page body — which is exactly the candidate content INTKB
  // stored. workspaceId is the basename of the brain root (ICO kernel spool.ts).
  if (!spoolDerived) {
    push(
      'candidate-id-derivation',
      'UNVERIFIABLE',
      `candidate source is '${candidate.source}' with no compile-side filePath — not a spool-derived candidate; its id is not content-addressed by design`,
    );
  } else {
    const candidateIdLink = candidateIdDerivationLink(
      db,
      candidate,
      basename(resolve(opts.brainDir)),
      relPath!,
    );
    push('candidate-id-derivation', candidateIdLink.status, candidateIdLink.evidence);
  }

  // Link 6 — THE BRIDGE: the spool manifest sidecar ICO emitted alongside the
  // spool file names this candidate id and pins the file's SHA-256.
  if (!spoolDerived) {
    push(
      'spool-manifest',
      'UNVERIFIABLE',
      `not a spool-derived candidate — no spool manifest exists by design`,
    );
  } else {
    const manifestFiles = opts.spoolDirs.flatMap((d) => collectManifestFiles(d));
    if (manifestFiles.length === 0) {
      push(
        'spool-manifest',
        'UNVERIFIABLE',
        `no *.manifest.json sidecars found under: ${opts.spoolDirs.join(', ')} — spool artifacts absent (rotated, or not present on this host)`,
      );
    } else {
      let found: { path: string; manifest: SpoolManifest } | null = null;
      for (const mf of manifestFiles) {
        const manifest = readManifest(mf);
        if (manifest?.candidateIds?.includes(candidate.id) === true) {
          found = { path: mf, manifest };
          break;
        }
      }
      if (found === null) {
        push(
          'spool-manifest',
          'FAIL',
          `scanned ${manifestFiles.length} manifest sidecar(s) under ${opts.spoolDirs.join(', ')} — none lists candidate ${candidate.id}; the spool bridge for this candidate is broken`,
        );
      } else {
        // Extra integrity: if the sibling spool file still exists, its current
        // bytes must hash to the manifest's pinned SHA-256.
        const spoolPath = found.path.replace(/\.manifest\.json$/, '');
        let fileNote = 'spool file no longer present (archived/rotated) — manifest entry stands';
        let fileMismatch = false;
        if (existsSync(spoolPath) && found.manifest.spoolFileSha256 !== undefined) {
          const actual = computeContentHash(readFileSync(spoolPath, 'utf8'));
          if (actual === found.manifest.spoolFileSha256) {
            fileNote = `spool file present and hashes to the pinned SHA-256 (${actual.slice(0, 12)}…)`;
          } else {
            fileMismatch = true;
            fileNote = `spool file present but hashes to ${actual}, manifest pins ${found.manifest.spoolFileSha256} — file modified after emit`;
          }
        }
        push(
          'spool-manifest',
          fileMismatch ? 'FAIL' : 'PASS',
          `manifest ${found.path} lists candidate ${candidate.id}; ${fileNote}`,
        );
      }
    }
  }

  // Link 7 — the compile-side chain: an ICO trace event referencing this
  // candidate's source relPath in <brain>/audit/traces/*.jsonl. This is the
  // COMPILE claim only — it evidences a compile pass emitted this page; it
  // says nothing about admission (that is link 3's chain).
  if (!spoolDerived) {
    push(
      'compile-trace',
      'UNVERIFIABLE',
      `not a spool-derived candidate — there is no ICO compile trace to look for`,
    );
  } else if (!existsSync(opts.brainDir)) {
    push(
      'compile-trace',
      'UNVERIFIABLE',
      `brain root ${opts.brainDir} does not exist on this host — compile-side evidence unavailable (expected e.g. on CI)`,
    );
  } else {
    const tracesDir = join(opts.brainDir, 'audit', 'traces');
    const hit = findTraceEvent(tracesDir, relPath!);
    if (hit === null) {
      push(
        'compile-trace',
        'UNVERIFIABLE',
        `no trace event with outputPath="${relPath}" under ${tracesDir} — traces absent or rotated past this compile (absence of evidence, not contradiction)`,
      );
    } else {
      const chained = hit.event.prev_hash !== null && hit.event.prev_hash !== undefined;
      push(
        'compile-trace',
        'PASS',
        `trace event ${hit.event.event_id} (${hit.event.event_type}) at ${hit.event.timestamp} in ${hit.file}${chained ? ', hash-chained via prev_hash' : ' (chain head: prev_hash null)'}`,
      );
    }
  }

  return finalize(memoryId, links);
}

function finalize(memoryId: string, links: WalkLink[]): WalkResult {
  const passCount = links.filter((l) => l.status === 'PASS').length;
  const failCount = links.filter((l) => l.status === 'FAIL').length;
  const unverifiableCount = links.filter((l) => l.status === 'UNVERIFIABLE').length;
  const exitCode = failCount > 0 ? 1 : unverifiableCount > 0 ? 3 : 0;
  return { memoryId, links, passCount, failCount, unverifiableCount, exitCode };
}
