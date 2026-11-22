# Provenance classification authority

**Status:** Proposed end-to-end contract with an implemented pure
assertion-verification primitive. Durable classification enforcement, ingress
adoption and rollout remain open.
**Date:** 2026-11-22
**Parent:** `compile-then-govern-39z.11.4`
**Contract/evidence task:** `compile-then-govern-39z.11.4.1`

## Problem and observed boundary

Content classification finds credential, PII and internal-path patterns. It does
not establish that an otherwise ordinary memo came from a private source.
Source-derived sensitivity needs authenticated source context and an approved
mapping. Neither an unsigned label nor a model's interpretation supplies that
authority.

The current origin mechanism remains governed by [ADR049](049-AT-DECR-write-time-provenance-origin-tokens.md):

| Surface                              | Observed authority                                                      | Limit for classification                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `common/origin-token.ts`             | HMAC of candidate ID, tenant and capture timestamp                      | Does not directly sign content, channel, repository, source, author, role or mint timestamp |
| `curator/origin/origin-gate.ts`      | Verifies exactly that tuple                                             | `attested` is the existing gate verdict, not authentication of every candidate field        |
| `schema/memory-candidate.ts`         | Closed structural origin shape; reserves `unattested`                   | Local channel is explicitly self-asserted                                                   |
| `curator/intake/candidate-intake.ts` | Team channel allowlist and authenticated member/admin quarantine marker | Allowlisting is not source ownership; `proposedByRole` is not a business-role directory     |
| `recovery/sensitivity-constraint.ts` | Validated durable reviewed/imported floors                              | Existing receipt kinds do not establish new provenance policies                             |
| `promotion/promoter.ts`              | Re-resolves floors and checks before commit                             | A new floor source must join these checks, not only policy evaluation                       |

The added origin-gate fixtures hold the tuple/token fixed while changing eight
other fields. Their expected v1 verdict remains `attested`. They demonstrate the
gate's binding limit, not acceptance by all intake, spool-validation or promotion
controls. Content-derived IDs provide indirect binding only where that derivation
is independently enforced; a claimed API/library UUID is not such proof.

## Proposed authority model

1. An operator enrolls a capture producer and approved source profiles in a
   server-owned registry. Enrollment is a reviewed configuration operation,
   separate from a candidate, its metadata and its policy proposal.
2. A profile names a finite tenant/producer/source context and a minimum
   sensitivity. Source context can include a stable repository identifier,
   capture channel and an externally authenticated principal or role binding.
   Optional dimensions are explicitly absent, not wildcard strings.
3. The trusted capture gateway selects the profile from its authenticated source
   event and configured source catalog. A client cannot pick a less restrictive
   profile by supplying another path, channel or role. Filesystem collectors must
   establish permitted canonical roots and repository identity; remote collectors
   must bind the authenticated account/channel. These adapters require their own
   evidence before enrollment.
4. The registrar verifies an independently provisioned producer public key and
   its allowed profile scope. A key carried inside the submitted assertion is
   not a trust root. Sharing a key or registry entry with snapshot transport is
   never implicit; each purpose has a separate domain and authorization.
5. A valid source assertion authenticates the producer's statement. It does not
   prove the statement is true, the producer is uncompromised, or the content is
   safe. Content scanning, ordinary governance and human review still apply.

There are no built-in director, salesperson or company-person mappings. Business
role data requires an approved identity source and versioned binding; it must not
be inferred from author names, email domains or `proposedByRole`. Actual mappings,
keys and deployment enrollment remain operator decisions.

## Proposed assertion and canonical binding

Use a separately versioned `source-classification-assertion-v1` envelope with
Ed25519 signatures and a purpose-specific domain prefix. Keep the existing
`CandidateOrigin` HMAC and candidate UUID-v5 derivation unchanged. Deliver new
evidence through a versioned intake envelope or separately persisted evidence
with an explicit consumer capability check. Do not add an optional field that a
v1 parser can silently strip and then call the route protected.

The canonical signed payload must bind all of:

- assertion format and purpose, producer ID and key ID;
- receiver/deployment audience and tenant;
- candidate ID and byte-exact capture timestamp;
- SHA-256 of content bytes and title bytes;
- declared source kind and authenticated channel/repository/principal binding;
- profile ID, profile revision and canonical profile digest;
- issue time, expiry, and a unique assertion ID for replay settlement.

Use one versioned canonical serializer shared by minting and verification, closed
schemas, explicit optional-field representation, bounded sizes and stable digest
rules. Refuse unsupported versions, unknown fields, ambiguous raw encodings and
malformed signatures. Tests must pin canonical bytes and domain separation.
No raw content, private paths, credentials or signatures belong in public audit
output. Private assertion storage needs the same custody controls as its source.

Verify content/title hashes against the actual candidate, not a supplied hash
field. If intake rewrites any bound field, refuse the assertion and require a
new one; do not silently sign a transformed claim. Server-owned quarantine and
author metadata may be added without changing the source binding, but those
fields cannot become classification inputs unless separately authenticated and
bound by the protocol. Bind the resulting governed candidate snapshot in the
receiver's acceptance receipt to preserve the input-to-output relationship.

## Enrollment and anti-stripping

Required evidence is selected from server-owned tenant/ingress enrollment,
never from the candidate's claim that it has an assertion. On an enrolled route,
missing, stripped, expired, revoked, wrong-purpose, wrong-receiver or unverifiable
evidence must not enter ordinary promotion. Use a typed rejection or existing
quarantine outcome with a stable reason; choose the exact adapter outcome during
implementation without treating it as approval.

A route is not protected if another ingress can submit the same tenant's content
without the requirement. Enrollment therefore needs a complete tenant ingress
inventory: API, local MCP, compiler spool, manual imports, curator direct calls,
merge/recovery and background jobs. Either enforce the requirement at the shared
promotion boundary or refuse admission through unsupported paths. A caller cannot
pass a boolean to waive it. Source APIs must not let a request choose legacy mode.

Unenrolled deployments retain ADR049's v1 compatibility. This is explicitly
outside the new guarantee, not a fallback for a failed enrolled assertion.
Present-but-invalid new evidence is refused even on an unenrolled route; it must
not be stripped or treated as an absent legacy field. A deployment cannot claim
coverage while any applicable ingress remains unenrolled or bypassable.

## Classification and durable restrictions

The receiver resolves the profile from its own registry and computes:

`effective = max(content classification, reviewed local floors, verified imported floors, verified source-profile floor)`

Use the existing sensitivity ordering. A new public profile cannot lower a prior
restriction, and non-monotonic blocked-level policies must still reject the
original classified level. A source profile does not grant audience access or
permission to promote material the existing policy blocks. Confidential and
restricted general-search exclusions remain unchanged.

Persist a new, strictly validated provenance-floor receipt kind binding tenant,
candidate and content, assertion digest, profile digest, enrollment revision,
key/producer authority and effective floor. Do not masquerade as a human recovery
receipt or import receipt. Resolve these restrictions for content aliases before
deduplication, so changing candidate ID or producer cannot erase a prior floor.
Define a documented format for replay identity: identical settled assertions are
idempotent; reused assertion IDs with different payloads refuse.

Prepare/preview is read-only and reports the exact proposed restriction and
policy outcome. Apply must bind the candidate, registry, profile, enrollment and
key-status snapshots. Re-read them inside the same write transaction as receipt,
policy outcome and promotion. Any mismatch refuses with no partial writes. The
no-policy path still enforces structural assertion validity and persisted floors.
Evaluation and promotion must consume the same verified context, never a caller's
unchecked `minimumSensitivity` or cached verification boolean.

Integrate the new receipt kind into every existing resolver, recovery path and
snapshot export/import verifier. Current unknown floor kinds refuse; do not relax
that guard merely to admit a new kind. Restriction transport must carry supported
verified evidence or a separately reviewed conservative constraint, never drop it.

## Policy and key lifecycle

For new admissions, require current enrollment, a current accepted profile
revision and a non-revoked authorized key. Expired or superseded assertions need
fresh issuance; a key/policy change between preview and apply invalidates the plan.
A registry service failure is not permission to use stale authority silently.

Settled restrictions remain in force if a profile is deleted, a key is revoked or
an assertion expires. Those events do not declassify previously admitted content.
Profile tightening does not retroactively relabel all stored rows by itself:
identify affected receipts, preview a finite backfill, re-evaluate and apply it
through a reviewed batch with failure/recovery evidence. Until that occurs, report
the historical coverage boundary explicitly.

Relaxing a profile affects prospective assertions only and cannot erase durable
floors. Any declassification or audience widening needs its separately authorized
workflow. ADR053's demand-deferred widening and embargo features are unchanged.

## Delivery and acceptance sequence

1. Review this contract and the v1 binding evidence. The implementation change
   must record its adopted contract and resolve remaining interface choices; a
   merged proposal alone is not implemented behavior.
2. Implement closed assertion/profile schemas, canonical-byte fixtures, scoped
   key verification and pure floor resolution on disposable fixtures.
3. Implement durable receipt/replay settlement and evaluation/promotion parity,
   including no-policy, aliases, recovery and authenticated restriction transport.
4. Implement each capture/ingress adapter and reviewed registry/enrollment
   tooling. Prove anti-stripping and actual caller adoption before claiming the
   feature complete; frozen consumer work remains held until its own gates clear.
5. Separately authorize staged and production enrollment, finite backfills and
   acceptance using approved data. Passing synthetic tests does not complete this
   operational step.

Required negative tests include changes to each bound field; unauthorized key,
profile or tenant; forged repository/role context; wrong receiver/purpose; absent
and stripped evidence; duplicate/ambiguous payloads; expiry/revocation; same-ID
replay mismatch; content aliases; profile/key drift before commit; policy-disabled
paths; non-monotonic blocked levels; unknown stored floor kinds; and injected
transaction failures. Positive tests cover every enrolled ingress, normal legacy
behavior on an unenrolled deployment, idempotent settlement and cross-clone
restriction preservation. Use synthetic sources and private disposable stores.

## Evidence and limits

At the contract milestone (PR469), source implemented v1 tuple verification,
reviewed/imported floors and current-store search authorization. That milestone
added no assertion implementation or enrollment. The subsequent primitive below
extends source capabilities without enrolling a producer, classifying a real
document, granting a business role, migrating a spool, changing an origin secret
or activating a consumer. Closing either bounded source task does not close
`compile-then-govern-39z.11.4` or the broader privacy parent.

## Implemented assertion primitive (2026-11-22)

Task `compile-then-govern-39z.11.4.2` implements the assertion/profile primitive in `apps/curator/src/origin/source-classification*.ts`. This is a library
primitive with synthetic tests. No running ingress calls it yet. The preceding
end-to-end requirements remain the target for tasks `.4.3` through `.4.5`.

The following choices describe the implemented primitive; they do not ratify the
remaining end-to-end proposal or authorize deployment enrollment:

- A separate strict v1 payload/envelope; legacy candidate and origin schemas are
  unchanged. Canonical JSON sorts object keys by ASCII order, preserves array
  order and uses explicit nulls for absent repository/principal bindings. Raw
  input must exactly match canonical serialization, rejecting duplicate keys,
  alternate escapes, whitespace and unknown fields. The envelope is at most
  16 KiB; content and title are each at most 1 MiB of round-trippable UTF-8.
- Ed25519 over `bbb-source-classification-assertion:v1` followed by NUL and the
  canonical payload. A registry key is exactly 32 raw public-key bytes encoded
  as lowercase hex; signatures are 64 bytes encoded as lowercase hex. Profile
  and registry digests use separate versioned domain prefixes. Canonical profile
  and payload fixtures pin byte ordering and hashes.
- ASCII identifiers are 1–128 characters. Profiles, keys and ingress enrollments
  each have at most 256 entries. Profile IDs are unique across a registry; keys
  are unique by producer/key ID; enrollments by receiver/tenant/ingress. Duplicate
  identities or scopes refuse, rather than selecting an arbitrary entry.
- Trusted receiver context supplies receiver, tenant, ingress and current time.
  All protocol timestamps use UTC with three fractional digits. No clock skew
  is allowed: issue time is inclusive, expiry exclusive, capture cannot follow
  issuance, and the assertion window is at most one hour and contained in the
  authorized key lifetime. These are new-protocol constraints, not v1 changes.
- The receiver registry independently authorizes the profile and producer key
  for that tenant, receiver and ingress. The current profile digest, revision
  and exact source context must match. Candidate content/title hashes, source,
  identity and capture time are checked directly. Author names, paths and
  member/admin quarantine labels supply no classification authority.
- Any required enrollment for a receiver/tenant makes missing evidence refuse
  even through another optional or unlisted ingress. Absent evidence is legacy
  only when that receiver/tenant has no required enrollment. Present evidence
  always needs an authorized ingress/profile and valid signature, even where
  enrollment is optional. This protects callers of the primitive; complete
  ingress coverage still requires `.4.4`.
- The result provides a prospective profile floor and assertion/profile/registry
  digests, enrollment revision and a hashed replay identity scoped to receiver,
  tenant, producer and assertion ID. Repeated valid assertions verify again;
  **replay settlement is not implemented here**. The next task must atomically
  compare assertion digests, persist floors and recheck current authority.

The verifier does no environment lookup, networking, model calls, registry
loading or durable writes. Its supplied registry and receiver context must come
from trusted integration code. A verification result is not promotion authority
and does not preserve historical restrictions by itself. Registry digests detect
changes only when a later consumer compares and revalidates them; they are not a
freshness service. Returning `legacy` is explicitly outside the new protection.
