# Proposed cross-clone sensitivity constraint contract

Status: **In development**. Bead: `compile-then-govern-39z.11`.
The authenticated source snapshot route is selected for implementation. Export
and verification plus transactional import are implemented as internal library
functions; the protected CLI/legacy boundary remains open. This does not change
admission or read policy, or certify cross-clone privacy preservation.

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
silently approve an absence of evidence. The selected route is the authenticated
source snapshot, subject to the authority assumptions below.

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

## Implementation prerequisite: duplicate preflight

The merge gate preflights every schema-normalized input before promotion
or persistence: content-derived identity, content digest, destination tenant and active
lifecycle. Copies sharing an identity must have identical normalized snapshots,
including audience and sensitivity. Conflicts refuse the whole pass regardless
of clone order; even differences in version, timestamps or policy evidence
require reconciliation outside this bare-row path. Object-key ordering does not
constitute a conflict. This deliberately replaces first-copy selection.

This preflight does not authenticate either clone, transport source floor
receipts, or prove that an export is complete. It is a prerequisite to the
transport contract, whose destination application is described below.

All destination-tenant rows must schema-normalize; an unrelated malformed row
also refuses the pass. Only matching rows participate in comparison: same-identity
snapshots must agree, and content-hash groups include existing destination copies.
Schema-normalized snapshots are compared in their JSON representation, so optional
undefined properties and absent JSON fields do not create false conflicts. An
identity already bound to another tenant refuses before persistence.
The dedupe seed is tenant-scoped; equal text in another tenant cannot suppress
this tenant’s import.

Content-hash deduplication also requires preflight: distinct identities with equal
content must agree on their schema-normalized semantic fields and destination-local
reviewed floors. The comparison excludes IDs, promotion/update timestamps and row
versions; it retains provenance, metadata, sensitivity and policy evidence.
Disagreement refuses the entire pass before persistence instead of letting the
lexicographically first identity win. Compatible content duplicates still use the
existing policy/bare content-hash deduplication. This checks supplied rows and
local constraints only; it does not establish omitted foreign constraints or
source authority, and therefore does not complete transport preservation.

Candidate IDs also bind one content digest across supplied and destination rows,
including destination rows in other tenants or non-active lifecycles;
a changed body cannot evade comparison by producing a different memory ID.
This checks consistency of available snapshots, not a reconstruction of a legacy
candidate’s original namespace/workspace/path inputs.

Preflight and promotions share a database transaction. Memory and audit repositories
must use the same connection. Apply starts an immediate transaction before preflight
and holds its write lock through promotion. Preview starts a deferred transaction;
the dry-run path performs no writes. Deferred mode itself is not a read-only guard. A later promotion failure rolls back the whole pass.
This holds the destination snapshot through writes; it does not lock remote sources
or authenticate source snapshots supplied by callers.

The merge checks affected candidate bindings across the destination store and
refuses pre-existing conflicts without rewriting either row. This is a merge
preflight, not a global write constraint or a migration of historical records.

Preflight refusals throw to the caller without appending a destination audit event;
this preserves the no-write refusal contract. Destination decoding failures are
identified as destination-side errors without including stored content. Affected
legacy snapshots that cannot meet this contract require separately reviewed
reconciliation; the merge does not infer a safe transformation or repair history.
Different curated bodies under one candidate ID are conservatively ambiguous here,
even if a future transformation could legitimately produce them. This does not
claim to reconstruct the original spool body digest from a candidate UUID.

Destination-tenant rows also revalidate content digests and derived memory IDs
before grouping or deduplication. Incoming candidate IDs already held by another
tenant refuse regardless of that row's stored memory ID or lifecycle, preventing
a legacy ID from bypassing tenant isolation. Equal text with a different candidate
ID in another tenant still does not suppress an import. Foreign rows are not
returned or repaired by the internal conflict query.

## Source snapshot implementation boundary (2026-11-22)

Child `compile-then-govern-39z.11.1.2` adds internal
`exportSourceSnapshot` and `verifySourceSnapshot` functions in
[source-snapshot.ts](../apps/curator/src/merge/source-snapshot.ts).
They do not write destination state or change the existing merge API/CLI.
Child `.3` adds the transactional application described below; `.4` owns
the public API/CLI and explicit legacy boundary. A successful verification alone must never authorize promotion.

The exporter reads all active canonical memories for one source tenant in a
single deferred transaction, verifies the entire source audit chain strictly,
and combines each stored sensitivity with its supported durable reviewed floor.
Any chain break, unverified row, unknown audit hash version, malformed applicable
floor, content/identity inconsistency or unsupported floor model refuses. Existing
historical forks are not exempted. The canonical disclosure scanner covers the entire memory object
before export. This is not a raw database archive or proof that every source
row originally passed promotion. Destination admission must re-govern content.

Version 1 binds the source identity, source and destination tenants, positive
sequence, issuance/expiry, key fingerprint, audit head, exact ordered inventory,
canonical memory fields, effective floors and candidate-scoped evidence digests.
Object keys sort lexically, array order is significant, and UTF-8 canonical JSON
is domain-separated with `bbb-source-constraint-snapshot:v1` followed by a NUL.
Ed25519 signs those payload bytes. Inventory and payload use SHA-256 over the same
domain plus their respective canonical JSON. The key ID is SHA-256 over SPKI DER.
The wire accepts at most 10,000 items and 8 MiB. Export currently materializes
source rows and audit history before enforcing output bounds; these limits do
not constitute a bounded-memory database scan.

A caller must independently obtain an authorized checkpoint containing the source
and tenant scope, Ed25519 public key/fingerprint, exact snapshot digest/sequence,
validity interval and revocation state. The verifier trusts no key embedded in an
artifact. It rejects unknown or default-filled wire fields, mismatched inventory,
wrong signatures, scope mismatch, revoked authority and invalid validity windows.
The entire snapshot validity window must fit the checkpoint interval; expiry is
exclusive. Verification uses an explicitly supplied trusted clock.

A signature establishes an attestation by the configured key, not that the signer
is honest. Completeness follows from the exporter covering its declared active
scope and the trusted authority pinning that exact inventory. Evidence digests
are source attestations; raw audit details are not transported or independently
replayed by the verifier. A malicious authorized signer can still omit facts.
An accepted checkpoint must come from a trustworthy channel that supplies the
operator's acceptable freshness; signatures and dates cannot discover a newer
source change or a revocation that the caller has not learned. Key enrollment,
private-key custody, checkpoint distribution/refresh and live authority are not
implemented here. Destination durable anti-rollback tracking is implemented by child `.3` below.

Export contains the source memory content and metadata, including restricted and
owner-audience rows. Only an authorized trusted local operator may call it and
handle the artifact; this library is not a public download endpoint or an audience
filter. It copies no raw audit reasons and returns no private key. All refusals
are sanitized category errors. No live source keys, trust registry, runtime
activation, production verification or full transport completion is claimed.

## Transactional destination implementation (2026-11-22)

Child `compile-then-govern-39z.11.1.3` adds internal `previewSourceImport` and
`applySourceImport` in [source-import.ts](../apps/curator/src/merge/source-import.ts).
The protected path accepts only signed snapshots and independently supplied
trusted checkpoints. Bare rows cannot enter it. Existing merge callers have not
been migrated; child `.4` still owns the exposed interface and compatibility work.

Preview reads a consistent destination transaction without writes. Apply refuses
an enclosing transaction and acquires its own immediate write transaction. Memory
and audit repositories must share the connection. The plan binds exact source,
authority, optional policy and destination digests. Apply revalidates them under
the write lock and checks authority and policy again before commit. Authority
providers and clocks are trusted local dependencies, never artifact instructions.
Plan hashes detect changes; they are not human authorization or trust enrollment.

Inputs are limited to 32 artifacts, 8 MiB total and 10,000 total source items.
Identical artifacts are collapsed. Source snapshots, destination rows and audit
history are materialized; no bounded-memory store scan is claimed. Strict audit
verification rejects breaks, unverified history and unknown hash versions before
import and at finalization. No historical amnesty or repair is performed.

Content, source provenance, title, category, author and metadata must agree for
equal-content groups. Audience is part of metadata. Conflicting curated or pending
candidate identities refuse. An existing non-inbox candidate also refuses: a
remote active snapshot cannot resolve a local human hold or supersede local
terminal review standing. Source governance outputs (sensitivity, trust, policy
evaluations, lifecycle, timestamps, promoter and version) are re-evaluated rather
than accepted as destination authority. Every source restriction, matching stored
destination sensitivity and supported durable alias restriction contributes to the
maximum floor before duplicate handling. Aliases retain their own content-bound
`imported-sensitivity-floor-v1` receipts, consumed by the shared review resolver.

Optional policy still tests both original and effective classification. Without
optional policy, disclosure and constraint verification remain mandatory. The
protected path supplies active destination content and deterministically ordered
new approved content to contradiction checks. An admission refusal retains the
verified restriction; it does not create a new memory. Matching existing rows are
conservatively tightened even when admission refuses, without reactivation or
changes to audience. New rows use canonical promotion and its receipt.

Finalization verifies every retained floor, tightening, promotion, source-progress
and batch receipt, every affected memory snapshot, the current effective floors,
and strict chain integrity. Missing writes or stronger constraints arriving during
finalization roll back the whole transaction. Later human hold release and ordinary
promotion resolve imported floors; requesting a lower floor cannot lower them.

Accepted sequence/digest receipts are scoped to source identity and both tenants.
Key rotation shares that sequence space. Older snapshots and same-sequence changed
snapshots refuse even if an old checkpoint is supplied again. A newer snapshot
with a weaker source floor cannot relax a retained destination restriction. Exact
batch replay returns its historical settlement without writes, promotion or
reactivation. This historical receipt is not a statement that a row is currently
active. Replay still verifies current supplied authority and accepted sequence.
Changing policy creates a distinct batch identity and requires a fresh preview.

The receipt chain is local and tamper-evident. It does not defend against an
administrator replacing the entire database and its local history. External
checkpoint authority, physical-store access controls, operator-facing locks,
post-commit indexing, live adoption and deployment remain separate work. The
source exporter now recognizes imported floors so subsequent authorized exports
preserve them; the version-1 effective-floor wire semantics are unchanged.
