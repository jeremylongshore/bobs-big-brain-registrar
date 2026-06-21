import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeEntryHash } from './audit-chain.js';
import {
  appendSignedMergeAnchor,
  computeSignedMergeAnchorHash,
  generateActorKeypair,
  readSignedMergeAnchors,
  signMergeAnchor,
  verifyMergeAnchorSignature,
  verifySignedMergeAnchors,
  type ActorKeypair,
  type SignedMergeAnchorRecord,
} from './signed-merge-anchor.js';
import type { AuditRepository, AuditChainRow } from './repositories/audit-repository.js';

/** Build a VALID hash chain (correct entry_hash + prev links) from a list of reasons. */
function buildChain(reasons: string[]): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev: string | null = null;
  reasons.forEach((reason, i) => {
    const base = {
      id: `id-${i}`,
      action: 'promoted',
      memory_id: `mem-${i}`,
      tenant_id: 'local',
      actor_json: '{"type":"ai","id":"curator"}',
      reason,
      details_json: '{}',
      timestamp: `2026-06-17T00:00:0${i}.000Z`,
      hash_version: 2 as const,
    };
    const entry_hash = computeEntryHash({ ...base, prev_entry_hash: prev });
    rows.push({ ...base, prev_entry_hash: prev, entry_hash });
    prev = entry_hash;
  });
  return rows;
}

/** Minimal AuditRepository: the anchor module only calls findAllChronological. */
function mockRepo(rows: AuditChainRow[]): AuditRepository {
  return { findAllChronological: () => rows } as unknown as AuditRepository;
}

/** The head entry_hash of a chain (the value that lands in `parents`). */
function headOf(rows: AuditChainRow[]): string {
  return rows.length > 0 ? (rows[rows.length - 1]!.entry_hash ?? '') : '';
}

describe('signed-merge-anchor', () => {
  let anchorPath: string;
  // Ephemeral per-test keypair — never a hardcoded key value anywhere.
  let keys: ActorKeypair;

  beforeEach(() => {
    anchorPath = join(
      tmpdir(),
      `gsb-merge-anchor-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    keys = generateActorKeypair();
  });
  afterEach(() => {
    if (existsSync(anchorPath)) rmSync(anchorPath);
  });

  it('generates a fresh Ed25519 keypair (hex DER, no hardcoded secret)', () => {
    const a = generateActorKeypair();
    const b = generateActorKeypair();
    // SPKI-DER ed25519 public key is 44 bytes (88 hex chars); PKCS8 is 48 (96 hex).
    expect(a.publicKeyHex).toMatch(/^[0-9a-f]{88}$/);
    expect(a.privateKeyHex).toMatch(/^[0-9a-f]{96}$/);
    // Two generations differ — real entropy, not a fixture.
    expect(a.privateKeyHex).not.toBe(b.privateKeyHex);
  });

  it('signs the MERGED chain head bound to its two clone parents', () => {
    const cloneA = buildChain(['a0', 'a1']);
    const cloneB = buildChain(['b0', 'b1', 'b2']);
    const merged = mockRepo(buildChain(['m0', 'm1', 'm2', 'm3']));
    const parents = [headOf(cloneA), headOf(cloneB)];

    const rec = appendSignedMergeAnchor(merged, anchorPath, {
      tenantId: 'local',
      parents,
      lamportClock: 7,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
      commitHash: 'deadbeefcafe',
      nowFn: () => '2026-06-18T00:00:00.000Z',
    });

    expect(rec.schemaVersion).toBe(2);
    expect(rec.chainedRows).toBe(4);
    expect(rec.chainHead).toBe(headOf(buildChain(['m0', 'm1', 'm2', 'm3'])));
    expect(rec.parents.sort()).toEqual([...parents].sort());
    expect(rec.lamportClock).toBe(7);
    expect(rec.commitHash).toBe('deadbeefcafe');
    expect(rec.signerPublicKey).toBe(keys.publicKeyHex);
    expect(rec.signature).toMatch(/^[0-9a-f]+$/);
    expect(readSignedMergeAnchors(anchorPath)).toHaveLength(1);
  });

  it('the anchor signs AND verifies for a valid keypair', () => {
    const merged = mockRepo(buildChain(['m0', 'm1', 'm2']));
    const parents = [headOf(buildChain(['a'])), headOf(buildChain(['b']))];

    appendSignedMergeAnchor(merged, anchorPath, {
      tenantId: 'local',
      parents,
      lamportClock: 1,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
    });

    const result = verifySignedMergeAnchors(merged, anchorPath, parents);
    expect(result.ok).toBe(true);
    expect(result.breaks).toHaveLength(0);
    expect(result.anchorCount).toBe(1);
  });

  it('parents are a SET — order-independent across A∪B vs B∪A', () => {
    const ha = headOf(buildChain(['a']));
    const hb = headOf(buildChain(['b']));
    const merged = mockRepo(buildChain(['m']));

    appendSignedMergeAnchor(merged, anchorPath, {
      tenantId: 'local',
      parents: [ha, hb],
      lamportClock: 1,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
    });

    // Verify with the parents passed in the OTHER order — still clean.
    const result = verifySignedMergeAnchors(merged, anchorPath, [hb, ha]);
    expect(result.ok).toBe(true);
    expect(result.breaks).toHaveLength(0);
  });

  it('links successive merge anchors into a hash chain', () => {
    const merged1 = mockRepo(buildChain(['m0', 'm1']));
    const first = appendSignedMergeAnchor(merged1, anchorPath, {
      tenantId: 'local',
      parents: [headOf(buildChain(['a'])), headOf(buildChain(['b']))],
      lamportClock: 1,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
    });
    expect(first.prevAnchorHash).toBeNull();

    const merged2 = mockRepo(buildChain(['m0', 'm1', 'm2', 'm3']));
    const second = appendSignedMergeAnchor(merged2, anchorPath, {
      tenantId: 'local',
      parents: [headOf(buildChain(['c'])), headOf(buildChain(['d']))],
      lamportClock: 2,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
    });
    expect(second.prevAnchorHash).toBe(first.anchorHash);
    expect(verifySignedMergeAnchors(merged2, anchorPath).ok).toBe(true);
  });

  it('a chain TAMPERED after anchoring FAILS anchor verification (HISTORY_REWRITTEN)', () => {
    // Anchor a clean 3-row merged chain.
    const original = mockRepo(buildChain(['m0', 'm1', 'm2']));
    appendSignedMergeAnchor(original, anchorPath, {
      tenantId: 'local',
      parents: [headOf(buildChain(['a'])), headOf(buildChain(['b']))],
      lamportClock: 1,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
    });

    // Attacker rewrites the first event and re-hashes the whole chain forward,
    // so the linear chain is internally consistent again.
    const rewritten = mockRepo(buildChain(['TAMPERED', 'm1', 'm2']));

    const result = verifySignedMergeAnchors(rewritten, anchorPath);
    expect(result.ok).toBe(false);
    expect(result.breaks.map((b) => b.reason)).toContain('HISTORY_REWRITTEN');
  });

  it('an edited anchor body FAILS (ANCHOR_HASH_MISMATCH + DAG_SIGNATURE_INVALID)', () => {
    const merged = mockRepo(buildChain(['m0', 'm1', 'm2']));
    appendSignedMergeAnchor(merged, anchorPath, {
      tenantId: 'local',
      parents: [headOf(buildChain(['a'])), headOf(buildChain(['b']))],
      lamportClock: 1,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
    });

    // Edit the anchored chainHead WITHOUT recomputing anchorHash or re-signing.
    const rec = JSON.parse(readFileSync(anchorPath, 'utf8').trim()) as Record<string, unknown>;
    rec['chainHead'] = 'forged';
    writeFileSync(anchorPath, JSON.stringify(rec) + '\n');

    const result = verifySignedMergeAnchors(merged, anchorPath);
    expect(result.ok).toBe(false);
    const reasons = result.breaks.map((b) => b.reason);
    expect(reasons).toContain('ANCHOR_HASH_MISMATCH');
    // The signature was over the original body, so it no longer verifies either.
    expect(reasons).toContain('DAG_SIGNATURE_INVALID');
  });

  it('a FORGER without the private key cannot produce a valid anchor over a tampered chain', () => {
    // Honest actor anchors a clean chain.
    const original = mockRepo(buildChain(['m0', 'm1', 'm2']));
    const honest = appendSignedMergeAnchor(original, anchorPath, {
      tenantId: 'local',
      parents: [headOf(buildChain(['a'])), headOf(buildChain(['b']))],
      lamportClock: 1,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
    });

    // Attacker tampers the chain, then tries to forge a fresh anchor over the
    // tampered head WITHOUT the honest actor's private key. They only have
    // their OWN ephemeral keypair.
    const forgerKeys = generateActorKeypair();
    const tampered = buildChain(['TAMPERED', 'm1', 'm2']);
    const tamperedRepo = mockRepo(tampered);

    // Strategy 1 — sign the tampered head with the FORGER's key but keep the
    // HONEST public key in the record (so it looks like the honest actor wrote
    // it). The signature is over the body under the forger's key, but the
    // embedded public key is the honest one, so verification fails.
    const forgedBody: SignedMergeAnchorRecord = {
      ...honest,
      chainHead: headOf(tampered),
      signature: signMergeAnchor(
        {
          schemaVersion: honest.schemaVersion,
          anchoredAt: honest.anchoredAt,
          tenantId: honest.tenantId,
          chainedRows: honest.chainedRows,
          chainHead: headOf(tampered),
          parents: honest.parents,
          commitHash: honest.commitHash,
          lamportClock: honest.lamportClock,
          prevAnchorHash: honest.prevAnchorHash,
          signerPublicKey: honest.signerPublicKey, // honest pubkey embedded
        },
        forgerKeys.privateKeyHex, // but signed with the FORGER's key
      ),
      anchorHash: honest.anchorHash, // not recomputed — also caught
    };
    expect(verifyMergeAnchorSignature(forgedBody)).toBe(false);

    // Strategy 2 — swap in the forger's OWN public key so the signature
    // verifies, but recompute the anchorHash too so it is self-consistent.
    // The record now verifies as a signed record... by the FORGER. Anyone
    // pinning the honest actor's key rejects it because signerPublicKey differs.
    const forgerSelfBody = {
      schemaVersion: 2 as const,
      anchoredAt: honest.anchoredAt,
      tenantId: honest.tenantId,
      chainedRows: honest.chainedRows,
      chainHead: headOf(tampered),
      parents: honest.parents,
      commitHash: honest.commitHash,
      lamportClock: honest.lamportClock,
      prevAnchorHash: honest.prevAnchorHash,
      signerPublicKey: forgerKeys.publicKeyHex,
    };
    const forgerSelfSig = signMergeAnchor(forgerSelfBody, forgerKeys.privateKeyHex);
    const forgerSelfRecord: SignedMergeAnchorRecord = {
      ...forgerSelfBody,
      signature: forgerSelfSig,
      anchorHash: computeSignedMergeAnchorHash(forgerSelfBody),
    };
    // The forger's self-signed record DOES verify its own signature...
    expect(verifyMergeAnchorSignature(forgerSelfRecord)).toBe(true);
    // ...but it carries the FORGER's public key, not the honest actor's. A
    // verifier that pins the honest actor's key sees a different signer.
    expect(forgerSelfRecord.signerPublicKey).not.toBe(keys.publicKeyHex);
    expect(forgerSelfRecord.signerPublicKey).toBe(forgerKeys.publicKeyHex);

    // And crucially: the forger can never produce a record that BOTH carries
    // the honest actor's public key AND passes signature verification over a
    // tampered head, because that requires the honest private key they lack.
    expect(verifyMergeAnchorSignature(forgedBody)).toBe(false);

    // End-to-end: the original honest anchor on disk, verified against the
    // tampered chain, fails on the rewritten head — the receipt catches the
    // tamper even before any forgery attempt.
    const endToEnd = verifySignedMergeAnchors(tamperedRepo, anchorPath);
    expect(endToEnd.ok).toBe(false);
    expect(endToEnd.breaks.map((b) => b.reason)).toContain('HISTORY_REWRITTEN');
  });

  it('flags a truncated merged chain (rows deleted since anchor)', () => {
    appendSignedMergeAnchor(mockRepo(buildChain(['m0', 'm1', 'm2'])), anchorPath, {
      tenantId: 'local',
      parents: [headOf(buildChain(['a'])), headOf(buildChain(['b']))],
      lamportClock: 1,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
    });
    const result = verifySignedMergeAnchors(mockRepo(buildChain(['m0', 'm1'])), anchorPath);
    expect(result.ok).toBe(false);
    expect(result.breaks.map((b) => b.reason)).toContain('HISTORY_TRUNCATED');
  });

  it('flags a DAG_PARENT_MISMATCH when the anchor does not attest the expected parents', () => {
    const merged = mockRepo(buildChain(['m0', 'm1']));
    appendSignedMergeAnchor(merged, anchorPath, {
      tenantId: 'local',
      parents: [headOf(buildChain(['a'])), headOf(buildChain(['b']))],
      lamportClock: 1,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
    });

    // Verify against the WRONG expected parent set.
    const result = verifySignedMergeAnchors(merged, anchorPath, [
      headOf(buildChain(['x'])),
      headOf(buildChain(['y'])),
    ]);
    expect(result.ok).toBe(false);
    expect(result.breaks.map((b) => b.reason)).toContain('DAG_PARENT_MISMATCH');
  });
});
