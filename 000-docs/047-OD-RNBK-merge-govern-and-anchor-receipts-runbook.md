# Merge-Govern & Anchor Receipts Runbook

**Document:** 047-OD-RNBK-merge-govern-and-anchor-receipts-runbook
**Date:** 2026-07-19
**Status:** Active
**Scope:** the `curator-cli merge-govern` subcommand (Wave-2 Track E3), the per-actor
Ed25519 signed merge anchor it can emit (Track F3), the signing-key custody + rotation
procedure, and the opt-in OpenTimestamps receipt for anchor heads (Track F4).

---

## 1. What merge-govern is

`curator-cli merge-govern` is the operator wiring for the govern-at-merge gate
(`apps/curator/src/merge/merge-gate.ts`, EPIC 1 bead `compile-then-govern-8da.9`). It
re-governs the UNION of two clones' promoted rows into a target store:

- every union row is re-projected to an **untrusted candidate** and re-judged from a
  clean slate — the disclosure/secret choke point first, then the target store's own
  enabled governance policy (dedupe, secret-detection, sensitivity, tenant-match, …);
- survivors are promoted through the **canonical promotion path** (content-derived ids,
  deterministic audit-chain append, deterministic merge clock);
- failures are **quarantined, never admitted** — reported by id + category + rule only,
  never content;
- the result is commutative: `merge-govern A B` and `merge-govern B A` produce
  byte-identical governed state and an identical audit chain.

### When to run it

- Reconciling two independently-promoted clones of a governed brain (the demand-gated
  distributed model, EPIC 1) — e.g. a teammate's local brain folding into the team brain.
- Rebuilding a merged store from two exported snapshots after a split-brain period.
- Previewing a reconciliation: `--dry-run` runs the full gate (validation, dedupe,
  quarantine decisions) and writes nothing.

### How to run it

```bash
# Preview (writes nothing):
curator-cli merge-govern cloneA.db cloneB.db \
  --db merged.db --tenant intent-solutions --dry-run --json

# Real merge, with a signed anchor over the merged head:
export MERGE_ANCHOR_PRIVATE_KEY_HEX="$(sops -d --input-type dotenv --output-type dotenv \
    secrets/merge-anchor-signer.sops.env | sed -nE 's/^MERGE_ANCHOR_PRIVATE_KEY_HEX=([0-9a-f]+)$/\1/p')"
curator-cli merge-govern cloneA.db cloneB.db \
  --db merged.db --tenant intent-solutions \
  --anchor ~/.teamkb/audit/signed-merge-anchors.jsonl \
  --commit "$(git -C ~/000-projects/bobs-big-brain-umbrella rev-parse HEAD)"
unset MERGE_ANCHOR_PRIVATE_KEY_HEX
```

**Read/write posture (the contract):** the two clone DBs are opened **READ-ONLY** and
are never written — they are evidence. The target `--db` is the **only** write surface
(`--db` is mandatory; the CLI refuses an implicit in-memory target because the governed
result would be silently discarded on exit). The governance policy is loaded from the
**target** store — the merged brain's own policy re-judges every row; with no enabled
policy, the disclosure choke point + content dedupe still apply.

### What merge-govern does NOT do

- **It does not trust either clone.** Rows are re-governed as `untrusted` regardless of
  their trust level at the source; prior receipts confer no standing.
- **It does not run supersession detection or mint wiki-link edges.** A merge is a
  re-govern of already-authored rows, not a fresh authoring event; supersession and
  relates_to edges belong to first promotion (curator / promotion service).
- **It does not run contradiction review.** `contradiction_check` passes vacuously in
  the merge path by design (see the E1 note in merge-gate.ts) — flagging near-similar
  rows here would silently drop content at merge time.
- **It does not repair a bad clone.** A row whose id is not content-derived
  (`MergeIdInvariantError`) aborts the whole merge before any write — fix the clone,
  don't launder it.
- **It does not delete or rewrite anything in the target.** Promotion is append-only by
  protocol; quarantined rows are simply never written.
- **It is not an incremental sync.** It governs the full union per run; running it twice
  is safe (content dedupe quarantines already-present rows as duplicates) but not a
  substitute for a real replication protocol.

---

## 2. Signed merge anchors (F3)

With `--anchor <path>`, a successful non-dry-run merge appends a
`SignedMergeAnchorRecord` (`packages/store/src/signed-merge-anchor.ts`, schemaVersion 2)
to the given log:

- **binds the merge DAG**: the merged chain head plus the two PRE-merge clone chain
  heads (`parents`, an order-independent set);
- **signed per-actor**: Ed25519 over the canonical body; the signer's public key is
  embedded in the record so any auditor verifies with no out-of-band key distribution;
- **hash-chained**: each record links to the previous by `prevAnchorHash`;
- **Lamport-clocked**: the CLI derives the clock as last-record + 1 for the log —
  monotonic per anchor log. The read→compute→append→verify section runs under an
  exclusive-create lockfile (`<anchor-path>.lock`), so two concurrent
  merge-govern invocations cannot read the same log tail and mint duplicate
  clocks (or fork the log's `prevAnchorHash` chain). A waiter times out loud
  after ~10 s (exit 1, no anchor written — the merge itself has already
  committed, so re-run the anchor step or investigate the holder); a lock older
  than 60 s is presumed a crashed holder and stolen. Same-host serialization
  only, matching the anchor log's single-host posture. Staleness keys on the
  lock file's creation mtime (no heartbeat); this is sound because the locked
  section — one JSONL read, one chain scan, one sign, one append, one
  re-verify — is sub-second in practice, two orders of magnitude below the
  60 s threshold, so a live holder cannot be mistaken for crashed. If the
  section ever grows stall-capable work (e.g. remote anchoring), add an mtime
  heartbeat alongside that change;
- **commit-pinned (optional)**: `--commit` accepts ONLY a 7–40 char hex commit
  SHA (case-insensitive; stored normalized to lowercase). A movable ref
  (`main`, `HEAD`, a branch name) is refused at parse time (exit 2) — a
  durable anchor must carry the immutable object id, never something that
  resolves differently later. Resolve first: `git rev-parse HEAD`.

Verify any time with `verifySignedMergeAnchors` (the CLI also self-verifies immediately
after appending and fails loud if the fresh anchor does not verify).

### Trust model — read this before quoting guarantees

Per-actor signatures give **cross-actor attribution for the MERGE path only**: a signed
anchor proves which key-holder anchored which merged head, and a forger who tampers with
the merged chain and re-hashes it forward still cannot produce a valid signature without
that actor's private key. **Local single-writer mode still has no non-repudiation**: a
single local actor holding both write access and the signing key can rewrite state and
re-sign it. Cross-actor guarantees additionally require the anchor log to be committed
somewhere the writer cannot quietly rewrite — the anchor-witness remote
(`045-OD-RNBK`) and/or an OpenTimestamps receipt (§ 4).

### Key custody

| Artifact                                                       | Path (repo)                                | Committed?                     |
| -------------------------------------------------------------- | ------------------------------------------ | ------------------------------ |
| Private key (hex PKCS8 DER Ed25519), SOPS/age-encrypted dotenv | `secrets/merge-anchor-signer.sops.env`     | yes (encrypted only)           |
| Public key (hex SPKI DER)                                      | `keys/merge-anchor-signer.pub`             | yes (plaintext — it is public) |
| Plaintext private key                                          | `/dev/shm` during generation/rotation only | **never**                      |

The CLI takes the private key ONLY via the `MERGE_ANCHOR_PRIVATE_KEY_HEX` environment
variable (never a flag — flags land in shell history and process listings) and derives
the public half from it at sign time, so a mismatched pub/priv pair is structurally
impossible. Auditors compare each anchor's embedded `signerPublicKey` against the
committed `keys/merge-anchor-signer.pub`.

**Two-recipient minimum (RULE):** before any real secret lands under `secrets/`, it
must be encrypted to at least TWO age recipients — the operator dev key (`age1me3v…`)
and an escrow key held elsewhere (here: the VPS host key `age1csyj…`,
`/etc/intentsolutions/age.key`). One recipient is a single point of loss: if that one
private key is destroyed, every committed secret is orphaned ciphertext. `.sops.yaml`
carries both recipients in every creation rule; verify a new/rotated secret decrypts
with the LOCAL key before committing (`sops -d … | head -c0 && echo OK`).

### Key rotation

Old anchors stay verifiable forever under their own embedded public key — rotation only
changes which key signs FUTURE anchors.

1. Generate a fresh keypair (plaintext touches tmpfs only):

   ```bash
   cd <repo> && umask 077
   node -e "
   const { generateActorKeypair } = require('./packages/store/dist/signed-merge-anchor.js');
   const { writeFileSync } = require('node:fs');
   const kp = generateActorKeypair();
   writeFileSync('/dev/shm/mas.private.env', 'MERGE_ANCHOR_PRIVATE_KEY_HEX=' + kp.privateKeyHex + '\n', { mode: 0o600 });
   writeFileSync('keys/merge-anchor-signer.pub', kp.publicKeyHex + '\n');
   "
   ```

2. Encrypt to BOTH recipients (operator + escrow — the two-recipient rule above),
   replace the committed key file, then destroy the plaintext:

   ```bash
   sops -e --input-type dotenv --output-type dotenv \
     --age age1me3vkelljqe2u4zcagja9ru5fdpfpw72xmch39fwle2cr0yfr4cs8vr5d8,age1csyjrdez6fhe97zsu3zden8j7x7xes6zm3yzce5fzz524wmqav4sc0vgz3 \
     /dev/shm/mas.private.env > secrets/merge-anchor-signer.sops.env
   shred -u /dev/shm/mas.private.env
   ```

3. Commit both files together (`secrets/merge-anchor-signer.sops.env` +
   `keys/merge-anchor-signer.pub`) with a rotation note stating WHY (schedule,
   suspected exposure, actor change). The commit boundary in the pub-key file's git
   history is the rotation record: anchors before it verify under the old key, after it
   under the new.
4. If rotating because of suspected private-key exposure, also re-verify the whole
   signed anchor log and cross-check the latest head against the anchor-witness remote
   (`045-OD-RNBK`) before trusting new merges — a compromised key could have signed
   anchors you did not write.

---

## 3. OpenTimestamps receipts for anchor heads (F4)

`scripts/ots-stamp-anchor.sh` is the **opt-in** wrapper that timestamps the LATEST
anchor hash of an anchor log (default `~/.teamkb/audit/anchors.jsonl`; also works
against the signed merge-anchor log):

```bash
scripts/ots-stamp-anchor.sh stamp            # stamp the current head (network)
scripts/ots-stamp-anchor.sh upgrade          # hours later: complete the pending proof
scripts/ots-stamp-anchor.sh verify           # verify / show attestation info
```

Artifacts land next to the log: `<log-dir>/ots/<anchorHash>.anchor` (the stamped
subject: hash + provenance) and `<anchorHash>.anchor.ots` (the proof). One-time client
setup, isolated venv (never a global pip install):

```bash
python3 -m venv ~/.local/lib/bbb/ots-venv
~/.local/lib/bbb/ots-venv/bin/pip install opentimestamps-client
```

**What the receipt gives you:** independent, Bitcoin-anchored proof that this
`anchorHash` existed by a point in time — so a local rewrite performed AFTER the stamp
cannot back-date itself past the receipt.

**Honest limits (do not overstate):**

- `stamp` needs network access to the public calendar servers, and the immediate result
  is a **pending** attestation — Bitcoin confirmation typically completes in a few
  hours, then `upgrade` embeds the final proof.
- `verify` is not zero-network: pending proofs contact calendar servers, and fully
  independent verification of a completed attestation needs a **local Bitcoin node**
  (`bitcoind`). Without one, the client reports the attested block info; cross-checking
  against a public block explorer is possible but trusts that explorer.
- A timestamp proves WHEN, not WHO — actor attribution is the signed anchor's job (§ 2).
- Deliberately **not wired into any blocking gate**: stamping is manual/cron opt-in, and
  a calendar outage must never stall governance.

First real stamp (2026-07-19, this box): head
`5a8f0c7962c3e7d4632821caa9b92dd910a4b4abb5520b023af5a167c4800a67` submitted to four
calendars (a.pool.opentimestamps.org, b.pool.opentimestamps.org, a.pool.eternitywall.com,
ots.btc.catallaxy.com); proof at
`~/.teamkb/audit/ots/5a8f0c…0a67.anchor.ots`, pending attestation as expected.

---

## 4. Failure modes

| Symptom                                            | Meaning                                                                                                    | Action                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| exit 2, usage message                              | bad flags / missing `--db` / `--tenant`, `--anchor` without the key env, or `--commit` given a non-SHA ref | fix invocation; decrypt the signing key first; `git rev-parse` the ref                                             |
| `timed out … waiting for the anchor lock` (exit 1) | another merge-govern is anchoring, or a fresh lock was left behind                                         | the MERGE already committed — retry to append the anchor once the holder finishes; a lock >60 s old is auto-stolen |
| `MergeIdInvariantError`                            | a clone row's id is not content-derived — it bypassed the canonical promoter                               | investigate the clone; do not merge until its provenance is explained                                              |
| quarantined rows in output                         | disclosure or policy refusal on re-govern                                                                  | expected behavior; review by id in the source clone                                                                |
| `signed-anchor verification FAILED after append`   | the just-written anchor does not verify                                                                    | stop; inspect the anchor log for tampering/corruption before further merges                                        |
| `ots verify` reports pending only                  | Bitcoin confirmation not yet complete                                                                      | re-run `upgrade` after a few hours                                                                                 |
