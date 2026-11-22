# Provenance classification authority

**Status:** Proposed end-to-end contract with an implemented pure
assertion-verification primitive, stored-authority governance and configuration
primitives. Ingress-wide
enforcement, adoption and rollout remain open.
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
  **the verifier itself does not settle replays**. The durable governance core
  below compares assertion digests, persists floors and rechecks current authority.

The verifier does no environment lookup, networking, model calls, registry
loading or durable writes. Its supplied registry and receiver context must come
from trusted integration code. A verification result is not promotion authority
and does not preserve historical restrictions by itself. Registry digests detect
changes only when a later consumer compares and revalidates them; they are not a
freshness service. Returning `legacy` is explicitly outside the new protection.

## Durable governance core milestone (PR471, 2026-11-22)

This section records the PR471 milestone. The stored-authority integration below
supersedes its supplied-registry interface; the other durable restrictions remain.

Task `compile-then-govern-39z.11.4.3` implements `previewSourceGovernance` and
`applySourceGovernance` as database-level functions. They have no CLI, HTTP, MCP,
collector or background-job call site. Task `.4.4` still owns actual ingress
adoption and enrollment loading; `.4.5` owns authorized operational acceptance.
The source assertion proves source-profile authority, not caller access standing.
The integrating caller must establish access authorization and trusted registry,
receiver, ingress and clock inputs independently of the captured request.

Preview uses a read transaction and writes nothing. It binds the stored candidate
and disposition, exact serialized assertion, receiver/ingress, registry/key/profile
snapshot, current policies, candidate/memory rows and audit-chain tip. It reports
the prospective minimum and configurable policy outcome. That policy result is
not a promise of promotion: existing origin, exclusion, review, hold, duplicate
and supersession controls still run during application. Multiple enabled policies
refuse instead of selecting an ambiguous policy.

Only inbox candidates can enter curation. For an already disposed candidate, the
plan explicitly selects restriction-only processing: record the source floor and
tighten aliases while preserving the candidate disposition and memory lifecycle.
This includes a new private-source assertion for an already promoted public
candidate with the same stable ID; learning that restriction must not depend on
inventing a different candidate ID. It never reopens a rejection or releases a hold.

Apply uses one immediate transaction. It refuses a changed plan, re-verifies
current source authority, records a new `provenance-sensitivity-floor-v1` receipt,
tightens pre-existing content aliases, and runs canonical curation with the same
durable floor. The receipt combines the authenticated source floor with content classification,
existing row restrictions and legacy candidate-scoped recovery floors. Rejected and
quarantined proposals retain their restrictions. A duplicate cannot leave its
older public row public. Audience and lifecycle do not widen; this function
refuses unapproved supersession. Member-tagged and Registrar MCP proposals retain
human-review quarantine; a source signature is not a human review or hold release.

A final authority reload and candidate/policy/configuration/receipt/row checks
occur inside the transaction. Failure rolls back the floor, alias tightening,
curation, disposition and settlement together. This requires a healthy existing
audit chain; it does not repair or excuse historical chain damage. Receipts carry
identities, classifications and digests, not source bodies or private context.

Replay identity is scoped to receiver, tenant, producer and assertion ID, and the
floor event identity deliberately excludes candidate ID. Reuse for another
candidate or payload refuses. An exact settled plan and identical serialized
assertion may return its historical outcome after expiry or revocation; this is
not a new admission, current authorization verdict, reactivation or replay of
writes. The caller still supplies matching receiver/tenant/ingress scope. A floor
without its enclosing settlement is incomplete and refuses admission.

Settled floors resolve independently of today's key/profile registry. Deletion,
expiry, revocation and a later weaker profile cannot erase them. Ordinary local
merge and selected human governance consume the shared floor resolver. Signed
snapshot export validates the new receipt kind, exports its effective restriction
and evidence digest, and existing authenticated snapshot import preserves that
restriction as an imported floor. Plain remote memory arrays carry no new source
authority; callers need the authenticated transport for cross-clone guarantees.
Unknown floor kinds still refuse.

This core inspects tenant rows and audit evidence when preparing a finite plan.
Its correctness tests do not establish sustained ingestion throughput, live
capture coverage, registry custody, deployment readiness or production adoption.

## Legacy enrollment guard milestone (PR472, 2026-11-22)

This section records PR472 behavior. The integration below supersedes the
separate authority context and absence of an evidence-capable admission path.

Task `compile-then-govern-39z.11.4.4.1` adds schema migration 12 and an
empty-by-default `source_classification_authority` singleton table with zero
rows. A provisioned record holds the existing strict versioned registry; it is independent of candidates,
request metadata and policy selection. This record is authoritative only for
the legacy guard; the source-governance core still uses its separately supplied
authority context. Those sources are not yet transactionally integrated. This
milestone has no provisioning API,
CLI, migration of existing authority, or operational enrollment. Tests populate
only disposable synthetic databases.

Before deduplication, `Curator.processSingle` refuses a tenant with any required
stored enrollment. `promote` repeats that check before preparing its result,
after acquiring the write transaction and before commit. The candidate and
configured curator tenant cannot select around each other's requirement. A
required enrollment applies across receiver/ingress names, so an optional or
unlisted alternate route cannot select legacy behavior. The refusal is
`SourceEnrollmentRequiredError` with code `SOURCE_ENROLLMENT_REQUIRED`.
Malformed registry data, an unreadable or missing table, and unknown schemas
refuse rather than treating authority as absent. Errors do not include registry
contents. A genuinely empty record set or a valid registry with no required
enrollment for that tenant preserves legacy admission outside the new guarantee.

This deliberately has **no evidence-capable exception yet**. Even the existing
source-governance core cannot promote an enrolled tenant through its curator
call; its enclosing transaction rolls back. Restriction-only processing and
quarantine are not new admissions. A prior floor receipt or a human hold release
does not waive enrollment. Preview's configurable policy result remains distinct
from the admission result, as documented above.

The next source milestone must integrate current assertion verification with
this stored authority transactionally, implement reviewed provisioning, and
exercise actual API/MCP/spool/import/recovery/background endpoints. This guard's
unit/integration evidence does not establish every endpoint's error mapping or
capture capability. Do not enroll a live tenant until those adapters and their
operational acceptance exist. Unsupported consumers, including frozen Plugin85,
remain held. No older-binary compatibility test is added here. Binaries predating
this feature are not expected to enforce the stored registry; rolling code back
after enrollment requires stopping writers and a separate compatibility plan.
Raw privileged SQLite writes remain outside this application-level guard. The
new table itself provides no independent tamper evidence against a privileged
writer.

## Stored-authority admission and configuration (PR473, 2026-11-22)

This section records the PR473 boundary. The following ingress milestone supersedes
its statements about governance package exports and endpoint availability; registry
configuration primitives remain internal.

Task `compile-then-govern-39z.11.4.4.2` connects the source-governance core to the
same stored registry used by legacy admission. `SourceGovernanceContext` now
supplies only trusted receiver identity/current time and the optional existing
origin secret. It cannot supply a registry. A repository-wide call-site search finds only tests invoking these core
preview/apply APIs; they are not exported from the curator package index and no
CLI, HTTP, MCP, collector or background-job entrypoint calls them here; these changes are not an
operational enrollment or complete ingress-adapter milestone.

Preview and apply load the strict registry from their SQLite connection. Missing
or invalid authority cannot fall back to an in-memory registry. Legacy calls
still refuse a required tenant enrollment. Source-governance application opens
an internal synchronous admission scope only after verifying current stored
authority and writing the matching durable source floor. The scope binds the
full candidate snapshot, exact assertion, receiver/ingress and authority digest.
It is private to that database connection and removed in `finally` on success or
failure. The helper does not reject a returned promise; the enclosing SQLite
transaction rejects promise-returning callbacks. No request boolean, metadata label or historical floor opens it.

The curator and promoter reverify the signature, time, current registry and
matching floor at their admission checks. A changed candidate, registry, key,
profile or receiver refuses. Removing a requirement while a source scope is
active also refuses rather than changing to legacy behavior. A second candidate,
second connection, later transaction or asynchronous continuation cannot inherit
permission. Source governance still owns ordinary policy, member quarantine,
holds, alias tightening, supersession refusal and final settlement checks. Exact
historical replay returns its prior outcome; it does not create new admission.
Trusted identity/clock callbacks are checked for row writes on the owning SQLite
connection, so detected writes also roll back on preview and replay paths.
This counter does not sandbox DDL, pragmas, other connections, arbitrary privileged
JavaScript or external effects; the callbacks remain trusted read providers.

`previewSourceAuthority` and `applySourceAuthority` are internal configuration
primitives. Their integrating caller must establish **whole-store host-operator
authority**, independently of any request. A declared human identity and `owner`
role are validated and bound into the plan; they do not authenticate a person or
turn a tenant owner into a host operator. No provisioning command, API endpoint,
installed consumer or live authorization is added here.

Configuration preview is read-only and binds the previous and proposed registry
digests, next revision, audit-chain tip and operator identity. Apply rechecks that
plan inside an immediate transaction and records a `source-authority-change-v1`
receipt with digests/revision under the `source-authority` audit tenant. The receipt
contains no profile catalog, key material or source content. Stored-record,
operator actor/role or receipt drift rolls back the change. The operator clock
may advance and is not bound into the operator digest. Repeated/stale plans refuse;
after an uncertain result, reconcile the current registry and receipt rather than
blindly retrying the previous plan.

Every configuration change requires the global registry revision to advance by one,
including key-scope changes and revocation. This initial path requires
valid scoped profile references and valid key lifetime ordering. It cannot remove
any enrollment or disable a required enrollment, lower an existing profile, change its source
binding, introduce a weaker profile for an already known receiver/tenant/source
context, delete existing profiles/key identities, replace key material under an
existing identity, or reactivate revoked signing material under any key identity. Changed profile and enrollment
entries also require advancing their own revisions; keys have no separate revision
field, so their changes are bound by the global registry revision and plan digest. Tightening, key revocation and adding
new identities remain possible through an exactly reviewed plan. Replacing key material
requires a new identity; revoking the old identity is a separate allowed change.
An active key cannot reuse material marked revoked in the previous or proposed
registry, including under a different producer or key ID. Broader relaxation,
pruning or de-enrollment needs a separate operation; no force flag is provided.

The configuration receipt supplies application-level audit evidence. The mutable
registry row is not independently authenticated against that receipt on each read,
and privileged raw SQLite changes remain outside this guard. No new tamper-evidence
claim is made for the table itself. Old-binary compatibility and rollback after
actual enrollment remain unverified. Parent `.4.4` retains actual capture and
endpoint/process adoption; `.4.5` retains operational acceptance requiring separate
authorization. Frozen consumers are not activated by this source milestone.

## Versioned API ingress implementation (2026-11-22)

The source implementation adds authenticated API governance over candidates already
accepted by canonical intake. It does not add a capture shortcut or a registry
provisioning endpoint. `TEAMKB_SOURCE_RECEIVER_ID` is server configuration; when
absent, the endpoint reports unavailable. Setting it does not create enrollment,
load producer keys, authorize live activation or demonstrate a deployed consumer.

An authenticated admin queries `GET /api/candidates/source-governance-capabilities`
and supplies an authorized tenant as usual. The response declares protocol version
1, configured and enrolled booleans, enabled only when both hold for that tenant,
the route and the fixed ingress ID
`api-source-governance-v1`. Enrollment presence is not proof of a usable signing
key or valid evidence; preview verifies those independently. No profile catalog
or key material is exposed.

`POST /api/candidates/:id/source-governance` accepts one strict envelope:

- Preview: `version: 1`, `tenantId`, `action: "preview"`, `assertion`.
- Apply: the same fields with `action: "apply"` and the exact returned `plan`.
- `assertion` is the canonical signed JSON string defined above. Unknown envelope
  fields, versions, caller clocks, receiver IDs, ingress IDs and profile overrides
  refuse. The profile inside the signed assertion still must match stored authority.

The server resolves the bearer token independently; loopback dev/admin is insufficient.
Admin standing and tenant scope are checked again when the core reloads its receiver,
including within the write transaction. The path ID, authorized tenant, stored
candidate and plan must agree. The API disclosure scan runs independently of tenant
policy. Canonical author/trust/status overrides, member quarantine, existing holds,
source floors and supersession refusal remain in place. Source signatures do not
release a hold or supply human-review authority. Configured import exclusions and
hold limits pass into curation and are bound into the preview digest; compiled
import matchers include their source and flags in that digest.

Intake still uses `POST /api/candidates`, including its per-actor quota. A returned
`already_exists` candidate may have a different ID because content deduplication
collapsed it. A producer must not relabel an old assertion with that returned ID:
the governance endpoint checks the signed identity and bytes against the selected
stored candidate. There is no automatic signature transfer or evidence persistence
in candidate metadata. Required tenants remain unable to promote through legacy
paths even when evidence is absent or stripped before arrival.

After settlement, the API requests the configured tenant index refresh, including
when aliases were restricted. A refresh failure reports `indexRefresh: "pending"`
without undoing committed governance. That result does not claim every external
index or installed client is refreshed. Historical settlement replay remains a
no-new-admission operation, while still requiring current request authorization.

### Supported and unsupported ingress inventory

| Surface                                         | Source behavior and evidence                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API canonical intake                            | Candidate-only; reserved evidence fields refuse before parsing. Existing scan, quota and actor overrides remain. HTTP tests cover no stripping and ID collapse.                                                                                                                           |
| API source governance                           | Supported preview/apply v1 over an existing candidate; Fastify `inject()` route tests cover current evidence, access, drift, rollback and member quarantine.                                                                                                                              |
| API legacy promotion                            | Required enrollment returns 422 `SOURCE_ENROLLMENT_REQUIRED` with the evidence route; unenrolled legacy promotion remains available.                                                                                                                                                      |
| API vault import                                | Creates inbox candidates only. Reserved evidence on the request refuses before filesystem access. Later admission uses the same guarded promoter.                                                                                                                                         |
| Registrar MCP propose/import                    | Does not accept source evidence. SDK calls over `InMemoryTransport` reject reserved fields; direct helpers also refuse. Ordinary proposals remain review-bound spool entries.                                                                                                             |
| Spool v1 writer/reader/intake                   | Reserved evidence fields refuse. Intake reports an admission rejection and retains the raw file; it does not archive it as successfully ingested. No source-evidence field is added to spool v1.                                                                                          |
| Curator CLI ingest                              | Actual child-process test proves required enrollment retains inbox candidates but exits nonzero with an actionable governance refusal.                                                                                                                                                    |
| Edge-daemon cycle                               | Required enrollment leaves curation incomplete and logs the evidence-route refusal; synthetic cycle test proves no promotion.                                                                                                                                                             |
| Selected recovery/manual governance             | [The existing real-store recovery test](../apps/curator/src/__tests__/source-governance.test.ts) (`does not let a historical source floor authorize selected human legacy admission`) proves a historical floor cannot waive required admission. No evidence-aware recovery CLI is added. |
| Merge and authenticated snapshot import         | Existing source restrictions survive; required destination enrollment refuses admission. Snapshot import preserves the enrollment error and rolls back its attempted floor/row writes.                                                                                                    |
| Standalone public plugin and Compiler producers | Adoption remains parent work. Frozen Plugin85 is unchanged; neither release nor installed-consumer compatibility is established here.                                                                                                                                                     |

The reserved top-level names are `sourceEvidence`, `sourceAssertion`,
`sourceClassification` and `assertion`. They are explicitly unsupported on a v1
candidate and on legacy capture/import surfaces. This rejects previously ignored
extension fields; valid candidate-v1 identity, content and UUID derivation are
unchanged. Documents imported as content are not themselves authenticated evidence.

These are source and synthetic-test boundaries. The parent retains trusted producer
capture, distribution and actual end-to-end adoption; live registry enrollment and
operational acceptance remain separately authorized work. The curator package exports
`previewSourceGovernance` and `applySourceGovernance` for the Registrar adapter.
The package is marked `private` in `apps/curator/package.json`, but that is a
publication setting, not an access-control mechanism. Direct library invocation
requires a trusted host caller with the store connection and receiver custody;
it is not an authenticated public interface. Bearer/admin/tenant authentication
is enforced by the HTTP route. Registry provisioning and the internal
`withVerifiedSourceAdmission` helper remain unexported from the package index.
The route tests use Fastify `inject()` and the MCP tests use SDK
`InMemoryTransport`; neither establishes socket-level or installed-consumer
behavior. The CLI test separately executes the compiled child-process entrypoint.

### Coordinated compatibility policy for evidence adoption

Candidate v1 remains a candidate-only protocol; the new evidence API is separately
versioned. Rejecting previously ignored reserved extension names is an intentional
validation tightening, not backward-compatible extension handling. A mixed fleet
of older and current readers is unsupported for evidence-enabled operation: an old
reader may discard these names, and binaries predating enrollment enforcement may
promote without this admission guard.

Before enabling enrollment or sending evidence, stop legacy writers and consumers,
verify every active Registrar admission path runs the guarded implementation, and
verify producers negotiate the tenant-specific API capability. Keep candidate v1
files free of evidence; send assertions only through the explicit API. Preserve
refused raw files for review rather than stripping fields or rewriting their IDs.
Rolling back to pre-enforcement binaries requires stopping writers and a separately
reviewed rollback plan. This PR neither performs that rollout nor establishes that
an installed fleet meets these prerequisites. Producer adoption and operational
acceptance remain open in the parent work.
