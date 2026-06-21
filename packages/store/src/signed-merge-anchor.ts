/**
 * Per-actor Ed25519-SIGNED merge anchor (bead `8da.7`).
 *
 * `audit-anchor.ts` already snapshots the chain head into an append-only,
 * hash-chained anchor log. That closes the silent-full-rewrite gap *for a
 * single linear chain* — but it does two things it cannot do on its own:
 *
 *   1. It does not bind a MERGE. When two clones are merged (EPIC 1's
 *      `mergeGovern`), the merged chain head has TWO parents — the pre-merge
 *      chain head of each clone. A plain `AnchorRecord` records only the merged
 *      head; it cannot attest "this head descends from exactly these two
 *      parents".
 *   2. It is not SIGNED. `anchorHash` is a SHA-256 over the body — anyone with
 *      write access can edit an anchor *and* recompute its `anchorHash` so the
 *      hash-chain re-verifies clean (the same tamper-evidence-not-proof limit
 *      called out in `audit-anchor.ts`). Integrity hashing proves the record
 *      was not *accidentally* corrupted; it does NOT prove WHO wrote it.
 *
 * This module adds a `SignedMergeAnchorRecord` (`schemaVersion: 2`) that binds
 * the merged chain head to its two clone parents and signs the whole body with
 * a per-actor Ed25519 key. Two independent checks then guard each record:
 *
 *   - the existing SHA-256 `anchorHash` integrity check (unchanged contract);
 *   - an Ed25519 `signature` over the canonical body, verifiable against the
 *     `signerPublicKey` embedded IN the record — so a forger who tampers with
 *     the merged chain and re-hashes it forward still cannot produce a valid
 *     signature without the actor's private key.
 *
 * ### DAG fields
 *  - `parents` — the two PRE-merge clone chain heads (each clone's last
 *    `entry_hash` captured before `mergeGovern` ran). Order-independent: a
 *    parent SET, not a tuple. A verifier asserts the merged head descends from
 *    exactly these heads.
 *  - `commitHash` — an optional Dolt/git commit SHA the merge landed on (or
 *    null when unavailable). Lets an external auditor cross-reference the
 *    merge against version-control history.
 *  - `lamportClock` — a per-actor monotonic logical clock. The caller owns the
 *    counter (persisted alongside the private key) and increments it before
 *    each signed anchor, so an auditor can order one actor's anchors causally
 *    independent of wallclock skew.
 *
 * ### Key custody (bead `8da.7`)
 *  - Generate a per-actor Ed25519 keypair once at brain setup via
 *    {@link generateActorKeypair} (Node `crypto.generateKeyPairSync`, no extra
 *    deps). Both halves are hex-encoded DER (SPKI public / PKCS8 private).
 *  - The PRIVATE key is stored ONLY in a SOPS-encrypted file (age-encrypted,
 *    mode 600) and loaded into a process-scoped variable at sign time — never
 *    committed in plaintext, never written to disk decrypted. A `.gitignore`
 *    rule blocks the plaintext form.
 *  - The PUBLIC key is recorded IN every anchor (`signerPublicKey`) so any
 *    auditor verifies the signature with no out-of-band key distribution. Key
 *    rotation just mints a new keypair; old anchors stay verifiable under their
 *    own embedded public key.
 *
 * Trust model: this record gives cross-actor non-repudiation of the merge
 * event — but only once the anchor log itself is committed somewhere an offline
 * editor cannot quietly rewrite (git push / OpenTimestamps), exactly as
 * `audit-anchor.ts` documents for the unsigned log.
 *
 * @module signed-merge-anchor
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import type { AuditRepository, AuditChainRow } from './repositories/audit-repository.js';

/** A per-actor Ed25519 keypair, both halves hex-encoded DER. */
export interface ActorKeypair {
  /** SPKI DER public key, hex-encoded. Safe to publish; recorded in anchors. */
  publicKeyHex: string;
  /** PKCS8 DER private key, hex-encoded. SECRET — never commit, never log. */
  privateKeyHex: string;
}

/**
 * Generate a fresh per-actor Ed25519 keypair. Both halves are hex-encoded DER
 * (SPKI public / PKCS8 private), the form embedded in anchor records and stored
 * (private half only) in the SOPS-encrypted key file.
 *
 * Native Node crypto — no third-party dependency. Call once per actor at brain
 * setup, persist the private half to SOPS, and record the public half in each
 * anchor. Tests call this in `beforeEach` to mint an ephemeral keypair so no
 * private key value is ever hardcoded.
 */
export function generateActorKeypair(): ActorKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKeyHex: publicKey.toString('hex'),
    privateKeyHex: privateKey.toString('hex'),
  };
}

/**
 * A merge anchor: the merged chain head bound to its two clone parents, signed
 * by a per-actor Ed25519 key. Linked into the same append-only, hash-chained
 * anchor log shape as {@link import('./audit-anchor.js').AnchorRecord}, but with
 * `schemaVersion: 2`, DAG fields, and a signature.
 */
export interface SignedMergeAnchorRecord {
  schemaVersion: 2;
  /** ISO-8601 timestamp the anchor was taken. */
  anchoredAt: string;
  tenantId: string;
  /** Number of CHAINED rows (entry_hash != null) in the merged chain. */
  chainedRows: number;
  /** The merged chain's head entry_hash ('' when there were no chained rows). */
  chainHead: string;
  /**
   * The two PRE-merge clone chain heads this merged head descends from. A
   * parent SET (order-independent), not a tuple. Empty-string entries are
   * allowed for a clone whose chain was empty at merge time.
   */
  parents: string[];
  /** Optional Dolt/git commit SHA the merge landed on (null when unknown). */
  commitHash: string | null;
  /** Per-actor monotonic logical clock at anchor time. */
  lamportClock: number;
  /** anchorHash of the previous anchor in this log (null for the first). */
  prevAnchorHash: string | null;
  /** SPKI DER Ed25519 public key (hex) that signed this record. */
  signerPublicKey: string;
  /** Detached Ed25519 signature (hex) over the canonical body. */
  signature: string;
  /** sha256 over the canonical body (everything above `anchorHash`). */
  anchorHash: string;
}

/** The signed body: every field except the two trailing integrity artifacts. */
type SignedMergeAnchorBody = Omit<SignedMergeAnchorRecord, 'signature' | 'anchorHash'>;

/**
 * Canonical body serialisation — FIXED key order, like `anchorBodyJson` in
 * `audit-anchor.ts` and `canonicalRowJson` in `audit-chain.ts`. Both the
 * signature and the `anchorHash` are computed over THIS exact byte string, so
 * the key order is the contract: changing it silently invalidates every
 * signature and hash already written.
 *
 * `parents` is sorted before serialisation so a parent SET — not a tuple —
 * canonicalises identically regardless of which clone was passed first. This is
 * what makes `mergeGovern(A, B)` and `mergeGovern(B, A)` produce a byte-
 * identical signable body.
 */
export function signedMergeAnchorBodyJson(b: SignedMergeAnchorBody): string {
  const sortedParents = [...b.parents].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return JSON.stringify({
    schemaVersion: b.schemaVersion,
    anchoredAt: b.anchoredAt,
    tenantId: b.tenantId,
    chainedRows: b.chainedRows,
    chainHead: b.chainHead,
    parents: sortedParents,
    commitHash: b.commitHash,
    lamportClock: b.lamportClock,
    prevAnchorHash: b.prevAnchorHash,
    signerPublicKey: b.signerPublicKey,
  });
}

/** SHA-256 hex digest over a signed-merge-anchor's canonical body. */
export function computeSignedMergeAnchorHash(body: SignedMergeAnchorBody): string {
  return createHash('sha256').update(signedMergeAnchorBodyJson(body), 'utf8').digest('hex');
}

/**
 * Sign a canonical merge-anchor body with a hex-encoded PKCS8 DER Ed25519
 * private key. Returns the detached signature, hex-encoded.
 *
 * The private key is reconstructed into a KeyObject inside this call and never
 * leaves it; the caller passes the hex string loaded from SOPS at runtime.
 */
export function signMergeAnchor(body: SignedMergeAnchorBody, privateKeyHex: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyHex, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
  const bytes = Buffer.from(signedMergeAnchorBodyJson(body), 'utf8');
  // Ed25519 takes a null algorithm — the curve fixes the digest.
  return edSign(null, bytes, privateKey).toString('hex');
}

/**
 * Verify a record's Ed25519 signature against the public key embedded IN the
 * record. Recomputes the canonical body bytes and checks the detached
 * signature. Returns false (never throws) on any malformed key, signature, or
 * mismatch — a forged or tampered record fails the check, it does not crash the
 * verifier.
 */
export function verifyMergeAnchorSignature(record: SignedMergeAnchorRecord): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(record.signerPublicKey, 'hex'),
      format: 'der',
      type: 'spki',
    });
    const body: SignedMergeAnchorBody = {
      schemaVersion: record.schemaVersion,
      anchoredAt: record.anchoredAt,
      tenantId: record.tenantId,
      chainedRows: record.chainedRows,
      chainHead: record.chainHead,
      parents: record.parents,
      commitHash: record.commitHash,
      lamportClock: record.lamportClock,
      prevAnchorHash: record.prevAnchorHash,
      signerPublicKey: record.signerPublicKey,
    };
    const bytes = Buffer.from(signedMergeAnchorBodyJson(body), 'utf8');
    return edVerify(null, bytes, publicKey, Buffer.from(record.signature, 'hex'));
  } catch {
    return false;
  }
}

function chainedRowsOf(repo: AuditRepository): AuditChainRow[] {
  return repo.findAllChronological().filter((r) => r.entry_hash !== null);
}

/** Parse the append-only signed-merge-anchor log. Returns [] when absent. */
export function readSignedMergeAnchors(anchorPath: string): SignedMergeAnchorRecord[] {
  if (!existsSync(anchorPath)) return [];
  return readFileSync(anchorPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as SignedMergeAnchorRecord);
}

export interface AppendSignedMergeAnchorOptions {
  tenantId: string;
  /** The two PRE-merge clone chain heads this merged head descends from. */
  parents: string[];
  /** Per-actor monotonic logical clock value (caller-owned counter). */
  lamportClock: number;
  /** Hex-encoded PKCS8 DER Ed25519 private key, loaded from SOPS at runtime. */
  privateKeyHex: string;
  /** Hex-encoded SPKI DER Ed25519 public key, recorded in the anchor. */
  publicKeyHex: string;
  /** Optional Dolt/git commit SHA the merge landed on. */
  commitHash?: string | null;
  /** Injectable clock for deterministic tests. */
  nowFn?: () => string;
}

/**
 * Snapshot the MERGED chain head, bind it to its two clone parents, sign the
 * body with the actor's Ed25519 private key, and append the record to the
 * signed-merge-anchor log.
 *
 * The merged chain head is read from `repo.findAllChronological()` after
 * `mergeGovern` has written its promoted rows — exactly the same source the
 * unsigned `appendAnchor` uses. The new record links to the prior one by
 * `prevAnchorHash`, extending the log's own hash chain.
 *
 * The private key passed in is used to sign and is NOT retained: load it from
 * SOPS into a process-scoped variable, call this, then drop it. After calling,
 * commit the anchor file externally (git push / OTS) to make the snapshot
 * tamper-EVIDENT against a later local rewrite.
 */
export function appendSignedMergeAnchor(
  repo: AuditRepository,
  anchorPath: string,
  opts: AppendSignedMergeAnchorOptions,
): SignedMergeAnchorRecord {
  const now = opts.nowFn ?? (() => new Date().toISOString());
  const rows = chainedRowsOf(repo);
  const head = rows.length > 0 ? (rows[rows.length - 1]!.entry_hash ?? '') : '';
  const existing = readSignedMergeAnchors(anchorPath);
  const prevAnchorHash = existing.length > 0 ? existing[existing.length - 1]!.anchorHash : null;

  const body: SignedMergeAnchorBody = {
    schemaVersion: 2,
    anchoredAt: now(),
    tenantId: opts.tenantId,
    chainedRows: rows.length,
    chainHead: head,
    parents: opts.parents,
    commitHash: opts.commitHash ?? null,
    lamportClock: opts.lamportClock,
    prevAnchorHash,
    signerPublicKey: opts.publicKeyHex,
  };

  const signature = signMergeAnchor(body, opts.privateKeyHex);
  const anchorHash = computeSignedMergeAnchorHash(body);
  const record: SignedMergeAnchorRecord = { ...body, signature, anchorHash };

  appendFileSync(anchorPath, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

/** A discrepancy in a signed-merge-anchor record or its log linkage. */
export interface SignedMergeAnchorBreak {
  /** Zero-indexed position in the anchor log. */
  index: number;
  anchoredAt: string;
  reason:
    | 'ANCHOR_HASH_MISMATCH' // an anchor record body was edited
    | 'ANCHOR_LINK_MISMATCH' // the anchor log was reordered / spliced
    | 'DAG_SIGNATURE_INVALID' // the Ed25519 signature does not verify
    | 'HISTORY_TRUNCATED' // chain now has fewer rows than were anchored
    | 'HISTORY_REWRITTEN' // the head at an anchored position changed
    | 'DAG_PARENT_MISMATCH'; // the anchor's parents do not match the expected set
  detail: string;
}

export interface SignedMergeAnchorVerifyResult {
  anchorCount: number;
  breaks: SignedMergeAnchorBreak[];
  /** True iff every anchor is hash-consistent, signed, linked, and head-consistent. */
  ok: boolean;
}

/**
 * Verify the signed-merge-anchor log against the live merged chain.
 *
 * Three independent guards per record:
 *  1. SHA-256 `anchorHash` integrity (record body not edited) + log linkage
 *     (`prevAnchorHash` chain intact).
 *  2. Ed25519 `signature` over the canonical body verifies against the
 *     embedded `signerPublicKey` — proves the record was written by the
 *     private-key holder, not merely that its bytes are self-consistent.
 *  3. The anchored `chainHead` still matches the merged chain's head row at the
 *     anchored row count — catches a silent rewrite the linear verifier misses.
 *
 * Never throws on tamper — surfaces every discrepancy via `breaks`.
 *
 * @param expectedParents Optional expected pre-merge clone-head SET. When
 *        provided, the LAST anchor's `parents` must equal this set (order-
 *        independent) or a `DAG_PARENT_MISMATCH` is reported.
 */
export function verifySignedMergeAnchors(
  repo: AuditRepository,
  anchorPath: string,
  expectedParents?: string[],
): SignedMergeAnchorVerifyResult {
  const anchors = readSignedMergeAnchors(anchorPath);
  const rows = chainedRowsOf(repo);
  const breaks: SignedMergeAnchorBreak[] = [];

  let expectedPrev: string | null = null;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;

    const recomputed = computeSignedMergeAnchorHash({
      schemaVersion: a.schemaVersion,
      anchoredAt: a.anchoredAt,
      tenantId: a.tenantId,
      chainedRows: a.chainedRows,
      chainHead: a.chainHead,
      parents: a.parents,
      commitHash: a.commitHash,
      lamportClock: a.lamportClock,
      prevAnchorHash: a.prevAnchorHash,
      signerPublicKey: a.signerPublicKey,
    });
    if (recomputed !== a.anchorHash) {
      breaks.push({
        index: i,
        anchoredAt: a.anchoredAt,
        reason: 'ANCHOR_HASH_MISMATCH',
        detail: 'anchor record content does not match its anchorHash',
      });
    }

    if (!verifyMergeAnchorSignature(a)) {
      breaks.push({
        index: i,
        anchoredAt: a.anchoredAt,
        reason: 'DAG_SIGNATURE_INVALID',
        detail: 'Ed25519 signature does not verify against the embedded signerPublicKey',
      });
    }

    if (a.prevAnchorHash !== expectedPrev) {
      breaks.push({
        index: i,
        anchoredAt: a.anchoredAt,
        reason: 'ANCHOR_LINK_MISMATCH',
        detail: `prevAnchorHash ${a.prevAnchorHash ?? 'null'} != expected ${expectedPrev ?? 'null'}`,
      });
    }
    expectedPrev = a.anchorHash;

    if (rows.length < a.chainedRows) {
      breaks.push({
        index: i,
        anchoredAt: a.anchoredAt,
        reason: 'HISTORY_TRUNCATED',
        detail: `anchored ${a.chainedRows} chained rows; chain now has ${rows.length}`,
      });
    } else if (a.chainedRows > 0) {
      const actualHead = rows[a.chainedRows - 1]!.entry_hash;
      if (actualHead !== a.chainHead) {
        breaks.push({
          index: i,
          anchoredAt: a.anchoredAt,
          reason: 'HISTORY_REWRITTEN',
          detail: `row ${a.chainedRows} head ${actualHead ?? 'null'} != anchored ${a.chainHead}`,
        });
      }
    }
  }

  if (expectedParents !== undefined && anchors.length > 0) {
    const last = anchors[anchors.length - 1]!;
    if (!sameSet(last.parents, expectedParents)) {
      breaks.push({
        index: anchors.length - 1,
        anchoredAt: last.anchoredAt,
        reason: 'DAG_PARENT_MISMATCH',
        detail: `anchor parents [${[...last.parents].sort().join(', ')}] != expected [${[...expectedParents].sort().join(', ')}]`,
      });
    }
  }

  return {
    anchorCount: anchors.length,
    breaks,
    ok: breaks.length === 0,
  };
}

/** Order-independent string-set equality (parents are a SET, not a tuple). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
