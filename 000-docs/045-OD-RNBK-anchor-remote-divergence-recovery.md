# 045-OD-RNBK — Anchor remote divergence recovery

**Status:** Active
**Date:** 2026-07-19
**Audience:** operators / agents on a box with `~/.teamkb`
**Related:** `packages/store/src/audit-anchor.ts` (verifyAnchors),
`packages/eval-surface/src/provenance-integrity.ts` (F2 anchor cross-check),
`packages/store/src/exception-manifest.ts` (3-state break classifier)

## What this runbook covers

The audit chain's external witness is a **private git remote** holding the
anchor log. This runbook explains what state that remote can be in relative to
the local anchor repo, what each divergence state means, and how to recover —
without ever destroying the evidence the witness exists to preserve.

## The trust framing (read this first)

The audit chain is tamper-**evident**, not tamper-proof. A writer with local
access can edit an event AND re-hash the chain forward, and intra-chain
verification passes again. The anchor log closes part of that gap locally, but
the anchor log is itself a local file — the same writer can regenerate it.

The **remote witness** is what makes a local rewrite **detectable** — not
impossible. Once an anchor commit is pushed to a remote that the local writer
cannot force-push, any later local rewrite of anchored history necessarily
diverges from what the remote already witnessed. Detection, ordering, and
evidence — that is the whole claim. Nothing here prevents the rewrite itself,
and local mode makes no cross-actor guarantee about _who_ performed a write.

## Estate facts (as deployed)

| Fact                | Value                                                               |
| ------------------- | ------------------------------------------------------------------- |
| Remote              | `jeremylongshore/bobs-big-brain-anchors` (private)                  |
| Local anchor repo   | `~/.teamkb/audit` (git repo, branch `master`)                       |
| Verified pushed tip | `32fa7cd08dd7abacc0403d6db80097d5c8d299a1`                          |
| Ruleset             | `protect-anchor-history` (id `19181703`)                            |
| Ruleset rules       | `non_fast_forward` blocked + deletion blocked, **no bypass actors** |
| Verified behavior   | force-push rejected with `GH013` (tested)                           |
| Push path           | the plugin fire-and-forget-pushes anchor commits on every govern    |

Because the ruleset has **no bypass actors**, not even the repo owner can
force-push or delete the branch through the normal push path. That is
deliberate: the remote's value is that its history moves only forward **while
the ruleset stands**. The ruleset itself is an admin-editable GitHub object —
a repo admin could delete or weaken it and force-push afterwards — so treat
any change to the `protect-anchor-history` ruleset as a governance event in
its own right (it is visible in the repo's audit log), and re-verify the
ruleset (`gh api repos/jeremylongshore/bobs-big-brain-anchors/rulesets`)
whenever this runbook is exercised.

## The divergence check

```bash
git -C ~/.teamkb/audit fetch origin
git -C ~/.teamkb/audit status
```

Interpret `status` (local `master` vs `origin/master`):

### State 1 — up to date

Nothing to do. The remote has witnessed everything local has anchored.

### State 2 — local AHEAD of remote

**Meaning:** anchor commits exist locally that have not reached the remote —
pushes are pending or the fire-and-forget push has been failing (network,
auth, GitHub outage). This is the only benign divergence state.

**Recovery:**

```bash
git -C ~/.teamkb/audit push origin master
```

A plain push. If it fails, fix the transport (token, network) and retry. Check
how long pushes have been failing — every unpushed anchor is a window in which
a local rewrite would have gone unwitnessed:

```bash
git -C ~/.teamkb/audit log --oneline origin/master..master
```

### State 3 — local BEHIND remote, or DIVERGED

**Meaning:** the remote holds anchor history the local repo does not. Since
the anchor log is append-only by protocol and only this box pushes to it, a
behind/diverged local repo means **the LOCAL history changed after anchoring**
— the local anchor repo was rewound, rewritten, or replaced. That is exactly
the rewrite signal the remote witness exists to catch. Treat it as an
integrity incident, not a sync inconvenience.

**Do NOT reconcile first. Investigate first.**

1. **Freeze:** stop govern runs (they would push new anchors on top of a
   suspect local state).
2. **Capture evidence** before touching anything:

   ```bash
   git -C ~/.teamkb/audit log --oneline --graph --all | head -50
   git -C ~/.teamkb/audit diff origin/master -- anchors.jsonl | head -100
   cp ~/.teamkb/audit/anchors.jsonl /tmp/anchors.local.$(date -u +%Y%m%dT%H%M%SZ).jsonl
   ```

3. **Run the store's rewrite tooling** against the live chain — the evaluator
   (`evaluateProvenanceIntegrity`) or `verifyAnchors` directly. A
   `HISTORY_REWRITTEN` / `HISTORY_TRUNCATED` / anchor-log-integrity finding
   confirms the live chain no longer matches what was anchored; classify chain
   breaks through the 3-state model (benign forks and byte-pinned documented
   exceptions are carried; tamper signatures are not).
4. **Explain the divergence** before any reconciliation: restored backup?
   disk corruption? deliberate edit? The remote's copy of the anchor log is
   the reference — it was witnessed at push time and cannot have been
   force-pushed (ruleset, no bypass actors).
5. **Reconcile only after the investigation concludes**, and only by moving
   local FORWARD to match the remote (e.g. re-clone the remote into
   `~/.teamkb/audit` and re-anchor the current chain head on top). **Never
   force-push** — the ruleset rejects it anyway (`GH013`), and attempting it
   is itself a signal worth alerting on.

### State 4 — remote unreachable

Not a divergence — a visibility gap. Fix transport. Until the remote is
reachable, anchors accumulate locally (state 2) and the witness is blind to
anything that happens in the interim.

## What the witness does NOT do

- It does not prevent local rewrites — it makes them detectable after the
  fact.
- It does not identify the actor — cross-actor non-repudiation needs per-actor
  signatures, which local mode does not provide.
- It does not witness what was never pushed — the gap between the last pushed
  anchor and now is unwitnessed by the remote (local anchors still cover it,
  with the weaker local trust model).

## How the evaluator consumes this (F2)

`evaluateProvenanceIntegrity` cross-checks the live chain against the local
anchor log on every run (`anchorLogPath`, default
`~/.teamkb/audit/anchors.jsonl`): `HISTORY_TRUNCATED`, `HISTORY_REWRITTEN`,
and anchor-log integrity breaks all fail closed; a missing/empty log is the
graceful bootstrap (`anchor_status: no_anchors_yet`). Benign chain forks and
byte-pinned documented exceptions are disclosed, not failed. The REMOTE
divergence check in this runbook is the manual, cross-machine complement: the
evaluator sees the local log; the remote proves the local log itself was not
regenerated.
