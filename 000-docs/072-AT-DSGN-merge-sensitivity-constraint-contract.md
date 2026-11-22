# Proposed cross-clone sensitivity constraint contract

Status: **Proposed**. Bead: `compile-then-govern-39z.11`.
This document specifies a review boundary; it does not implement transport,
change admission or read policy, or certify cross-clone privacy preservation.

## Existing behavior and gap

Source baseline: Registrar `0ec35ccd92ef421bb59382b482e622c50cf5d96f`.

[merge-gate.ts](../apps/curator/src/merge/merge-gate.ts) accepts curated rows,
projects them into untrusted candidates, and discards their stored sensitivity.
It resolves minimum sensitivity from the destination audit repository before
policy evaluation and canonical promotion. A remote candidate ID does not convey
its source constraints.

[sensitivity-constraint.ts](../apps/curator/src/recovery/sensitivity-constraint.ts)
validates local reviewed floor receipts and combines them monotonically.
[promoter.ts](../apps/curator/src/promotion/promoter.ts) reclassifies content and
checks durable constraints during promotion. These protections do not authenticate
foreign receipts or establish that an export included every applicable floor.

A pricing draft with an approved confidential floor can lack recognizable PII.
Copying its content and ID without its constraint therefore cannot establish the
privacy boundary. Trusting the row's claimed sensitivity would introduce a
separate authority problem.

## Required invariants

A future import must bind the exact candidate content, source and destination
tenants, source authority, and reviewed constraint evidence. Content hashes use
the existing canonical content-hash contract; any normalization must be explicit
and occur before approval. Candidate identity alone is insufficient.

Source-chain integrity is tamper-evident, not source authentication. A verifier
must separately establish who may attest constraints for that source and tenant.
An authenticated receipt also does not prove completeness: stripping a newer,
stricter receipt must not allow an older, weaker floor to pass.

A versioned bundle should bind its complete item inventory, each content digest,
constraint snapshot, source identity, destination scope, and validity conditions.
Verification must establish both the snapshot authority and its acceptable
freshness. Missing evidence is an unresolved constraint, never an implicit public
classification. Unknown versions, changed content, tenant mismatch, expired or
revoked authority, and incomplete inventories refuse before writes.

The effective floor combines all verified source floors and destination floors
monotonically. Duplicate candidate/content identities must reconcile evidence
before row deduplication; reversing clone order must not change the result.
Conflicting content for one identity refuses. No first-row-wins constraint rule.

Policy evaluation must preserve refusal of the original classified level as well
as the effective level when blocked-level configuration is non-monotonic. A higher
floor must not accidentally bypass a rule that blocks the original lower level.
Disabling optional policy evaluation must not disable constraint verification.

Promotion must recheck the bound destination snapshot and authority validity
inside the write transaction, retain the destination constraint receipt, and
verify receipt retention. Any stale evidence or failed retention rolls back the
bounded operation. Subsequent reviews must resolve the imported floor through
the same durable enforcement path, without trusting caller metadata.

## Two implementation routes to review

| Route                            | Authority and completeness                                                                                                       | Remaining design work                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Authenticated source snapshot    | Authorized source attests the full scoped inventory and effective constraints at an accepted checkpoint.                         | Trust enrollment, revocation, freshness, canonical encoding, anti-rollback and omission proof. A signature alone is insufficient.          |
| Destination-reviewed finite plan | Authorized destination owner/admin reviews exact input and evidence digests and approves conservative floors for a finite batch. | Review UX, unresolved-source handling, plan expiry and transactional snapshot binding. Human review cannot establish unknown source facts. |

The finite-plan route can reuse local reviewed-operation patterns without
claiming a deployed federation trust service. It must refuse unresolved source
restrictions or apply an explicitly reviewed conservative bound; it cannot
silently approve an absence of evidence. Neither route is selected by this doc.

The current bare-row merge API must not be relabeled as constraint-preserving.
Before implementation, choose an explicit compatibility boundary: reject bare
foreign rows in the governed transport path, or retain them only in a separately
identified legacy surface with no such preservation claim. Silent grandfathering
would leave an evidence-stripping bypass. This choice needs caller inventory and
migration tests before rollout.

## Acceptance evidence for implementation

Use disposable stores and synthetic records. Required cases include:

- Valid constrained content retains its floor after merge and later human review.
- Changed content, tenant, authority, version or evidence digest refuses.
- Removed evidence, omitted items, stale checkpoints and replayed weaker snapshots
  cannot downgrade the accepted constraint.
- Duplicate evidence in reversed clone order yields identical effective floors;
  contradictory identity/content bindings refuse.
- Destination constraints changed after evaluation cause refusal or reevaluation
  under the transaction, never promotion using a stale floor.
- Original classified-level refusal survives a stricter effective floor.
- Optional policy disabled still enforces the transport and promotion boundary.
- Malformed or unretained destination receipts roll back writes.
- Repeated application is idempotent and cannot relax an existing floor.
- Legacy callers cannot reach a purportedly protected path by stripping the bundle.

Each result must distinguish input verification, policy decision, retained
receipt and final stored sensitivity. Passing fixtures does not establish live
source authority, deployment, or production verification.

## Scope that remains open

This contract addresses transport of restrictions, not provenance-based business
classification, changes to role/audience access, privacy-safe suppression counts,
or time-based declassification. Existing audience controls must be preserved;
confidential records must not become visible as a side effect of this work.
Any future declassification needs separate authority and evidence rather than
expiry silently lowering a durable floor. The parent bead remains in progress.
