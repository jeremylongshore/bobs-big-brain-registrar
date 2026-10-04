# Decision Record — Claim-level audience governance (Epic K, bead K1)

**Date:** 2026-10-04

**Status:** ACCEPTED 2026-10-04 — the owner approved it by instruction to the CTO session ("merge #358 and
finish everything"). Drafted by the CTO session on the owner's "do everything still open" delegation; K2, K3 and K6
may start, in that order. To change any call, edit the table row and re-record the decision.

**Primary bead:** `compile-then-govern-dgr` (K1) · parent epic `compile-then-govern-ca6`

**Plan:** umbrella `000-docs/019-PP-PLAN` Epic K

## Decision requested

Approve the ship/defer calls and build order below for K2 through K8, and confirm the standing placement
constraint: the audience field lives inside the deterministic `PolicyPipeline`, extending `CuratedMemory`,
never bolted on beside it.

## Why now (new evidence since the plan was written)

On 2026-10-04 a whole-brain secret sweep (17,961 memories) found one active memory containing plaintext
passwords, promoted through the admission gate. It is archived and out of default search, but the plaintext
remains in the store and in the encrypted backups, and the platform has no governed way to *narrow* a
claim after promotion (beads `39z.16`, `39z.17`). That is exactly K3's gap, and it is now an observed
incident, not a design-doc worry. The audit also shows the other half of the thesis holds: tenant isolation
and the binary sensitivity gate worked as designed, because the problem is not who can see the brain, it is
what stays in it after the context changes.

## Recommendation per bead

| Bead | Call | Shape | Order |
|---|---|---|---|
| **K2** audience/scope field | **SHIP** | Optional field on `CuratedMemory`, zero store migration (JSON-validated column). Start minimal: a small closed set of audience tiers inside a tenant (e.g. owner, admins, team), default = tenant-wide so every existing memory keeps today's behavior. | 1st |
| **K3** narrowing rule | **SHIP, expanded scope** | New `PolicyRuleType` for narrowing, plus a governed redact/purge transition that rewrites content with a hash-chained receipt and forces a re-backup. Fold `39z.16` into K3 so there is one mechanism, not two. Measured on its own precision/recall fixture (KR8.2). | 2nd |
| **K6** human-escalation HOLD | **SHIP** | Bounded HOLD state for ambiguous audience or secret decisions, reusing the `014-AT-DECR` recommend/pipeline-owns split. The model may recommend; the pipeline owns the state. | 3rd |
| **K4** widening-with-redaction | **DEFER** | Build only when a second audience tier has real users. Without K2 in use there is nothing to widen. Keep the `SupersessionLink`-style provenance design on file. | on demand |
| **K5** embargo timestamp | **DEFER** | No demand signal. If ever built, it proceeds on adjacent authorization-propagation literature plus the existing `SearchScope` pattern; it does not wait for a direct citation (none exists, see `018-RL-RSRC`). | on demand |
| **K7** offboarding-aware partitioning | **KEEP deferred R&D** | As planned: a named bead, no decomposition. Nothing to build without literature or demand. | — |
| **K8** cross-organization exchange note | **DO NOW (doc-only)** | A short note distinguishing it from Epic I's single-operator federation. No build bead. | now |

## Placement constraint (confirmed)

The audience field and every rule that reads it live inside the deterministic `PolicyPipeline`. The model
never decides or writes audience; it may only recommend. This follows from the architecture thesis ("the
model proposes; the deterministic system owns durable state and control") and from KR8.1. No revision.

## K5 citation gap (resolved)

GSB does not wait for a stronger citation. K5 is deferred on demand grounds, not citation grounds; if it is
ever built it ships on the adjacent literature and the existing `SearchScope` pattern, with the gap stated
plainly in its acceptance notes.

## Risks and what this does not do

- **Effort:** K2 and K3 are each size M; K6 is M and touches the plugin as well as the registrar.
- **K3 vs the audit chain:** a content rewrite must not break `verifyAuditChain`. The redaction receipt must
  chain forward from the existing head; the design must prove old receipts still verify. This is the hard
  part and the reason K3 comes before widening anything.
- **Not covered:** rotating credentials that were already exposed (an owner action, tracked in `39z.16`),
  and any cross-tenant exchange (K8).
- **Rollback:** every K bead ships behind its own PR and is reverted independently; K2's default keeps
  behavior unchanged for all existing rows.

## Acceptance record

Accepted 2026-10-04 by the owner's instruction in the CTO session. Bead `compile-then-govern-dgr` closes with this
merge. K2, K3, K6 unblock in that order; K8 is written as a doc note; K4/K5 stay deferred on demand; K7 stays deferred R&D.
