# Reviewed finite staleness settlement

Source contract for `compile-then-govern-39z.2.3` and caller `compile-then-govern-39z.2.4`. The internal Curator core in
`apps/curator/src/staleness/reviewed-staleness.ts` changes a finite reviewed set
on one caller-supplied SQLite connection. An opt-in API caller now binds this core to authenticated review authority and
a physical store. Disposable-store tests do not establish permission to run
it against a live Brain. Installation and live acceptance remain separate.

## Review artifact and dependencies

The strict version-1 manifest selects one tenant and 1–100 unique memories. It
declares a human reviewer, admin or owner role, review time, reason and operation.
Each selection binds a canonical memory digest, complete stored-row digest,
rule ID and digest, and scope assessment with an evidence reference. Reactivation
also binds the earlier deprecation receipt by ID and digest. Unknown manifest
fields are rejected before normalization to JSON; optional undefined fields have
the same representation as omitted fields.

The caller supplies an independently approved manifest SHA-256. Computing that
digest from an unreviewed request does not establish approval. Declared actor,
role and scope are assertions, not authentication. Audience checks restrict the
selected memories to the declared role; trusted callers must establish the real
identity, authority, current policy applicability and exact selection approval.

Installed rules are trusted dependencies. Every selected rule must have an exact
digest match, retirement-review remedy, historical exemption enabled and pinned
source references. A synchronous resolver supplies already captured source bytes;
the core recomputes each SHA-256 and refuses missing or mismatched bytes, including
private evidence. It fetches no arbitrary URLs. Matching bytes establish identity
with the pinned record, not authenticity, currentness or permission. Historical
rules retain the limitations described in [065](065-AT-DSGN-staleness-rule-evidence-and-scope.md).

## Atomic state and receipts

The core uses canonical `MemoryRepository` and `AuditRepository` instances on the
same connection inside one immediate transaction. An already open transaction is
refused, so the core cannot silently use a savepoint under a deferred transaction.
It requires a strictly verified audit chain before and after a new settlement:
forks and unhashed historical rows are refused, without exceptions, rehashing or
an alternate verification policy.
Chain verification inspects the connection's global audit chain; this is not a
tenant-isolated database read surface.

Before writing, every selected row must match both reviewed digests and the
required source lifecycle. The raw-row digest binds all returned SQL columns and
the original metadata JSON string, including keys stripped by schema parsing.
This is value-level stored-row identity, not a physical database file hash.
Deprecation reruns the detector with the reviewed applicability assessment and
requires a retirement candidate. Renames, external scope and ambiguous narrative
matches cannot become deprecations through this path.

Each lifecycle change uses the canonical repository and adds a per-memory audit
event (`demoted` or `promoted`) with a deterministically derived ID. Receipt
timestamps depend on execution time and are pinned during exact replay.
A final `governed` run event binds
all transition receipt digests. Receipts retain rule and manifest hashes, state
digests, source-reference hashes and the declared actor. Review reason and scope
reference text are hashed; source bytes are not copied into receipts. The manifest
itself remains the caller's review artifact and is not archived by this core.

Final readback compares the complete selected rows and canonical receipts with
their expected values. Ignored writes, ignored receipt inserts, explicit SQL
failures and late triggers altering earlier selected rows or receipts cause the
whole transaction to roll back. Tests also verify that ordinary settlement leaves
unselected and other-tenant rows unchanged. This does not defend against a party
able to rewrite the database, its audit chain and the caller's evidence together.

## Replay and separately reviewed reversal

Exact replay verifies the existing run and every transition receipt against the
manifest, trusted rule definitions and current settled rows. It reconstructs the
reviewed before-state from the current row and receipted prior timestamp, verifies
both reviewed digests, and compares the full expected receipts. It writes nothing.
Changed plans under the same run identity, edited or reactivated rows, and missing
or altered receipts are refused.

Reactivation is a new manifest and run, bound to the current deprecated row and
its prior deprecation receipt. The earlier run must also contain the exact receipt
binding. It preserves current content and metadata, including edits made since
deprecation; it does not restore an old payload. Reactivation does not require the
current row to remain a retirement candidate. Its reason and authority need their
own review outside the core.

## Validation and remaining integration

The focused disposable-store suite covers finite selection, both snapshot forms,
source-byte refusals, scope and candidate refusals, SQL rollback controls, full
receipt replay and current-state-bound reversal. See
[reviewed-staleness.test.ts](../apps/curator/src/__tests__/reviewed-staleness.test.ts).
Repository-wide validation and configured review results belong to the source PR;
this document is not an independent acceptance certificate.

No live invalidation is included. Live use still needs current policy evidence,
independent approval of the exact finite live selection and authorized installation. Anchoring,
export/index refresh and measured corpus effects remain outside this transaction.
This source unit does not exercise deployment probes, FAMA or Recall@10 acceptance.

## Opt-in authenticated API caller

`TEAMKB_STALENESS_APPROVAL_FILE` enables `POST /api/memories/reviewed-staleness`.
Unset or empty leaves the route absent. Opt-in startup opens only an existing,
current-schema database; it does not create or migrate the reviewed store. The
request body is the strict manifest, with no database path, source path, approval
path or trusted digest override. The configured API connection determines the
canonical database path.

The caller resolves the bearer through the existing token registry. It refuses
synthetic loopback dev authority, shared identities, members and agents. The
named reviewer and exact admin/owner role must match both manifest and approval;
token tenant restrictions apply. Resolution repeats after the blocking write-lock
wait, so expiry or revocation observed by the registry prevents settlement.
This authenticates the credential identity, not physical human presence.

The operator supplies an independently approved, canonical absolute JSON path
in an owner-private directory. The file must be owner-private, regular and
single-link, bounded to 8 MiB. Its strict schema is:

- `version`: `1`.
- `manifestDigest`: canonical SHA-256 from `reviewedStalenessDigest` after review.
- `actorId`, `role` (`admin` or `owner`), and `tenantId`: approved authority.
- `expiresAt`: finite ISO datetime; expiry refuses admission.
- `store`: the `inspectRecoveryStore` witness containing `databasePath`,
  `basePath`, `baseDevice`, `baseInode`, `databaseDevice`, `databaseInode`.
- `sources`: at most 100 objects with `sha256` and canonical `base64` captured
  evidence, each decoded payload at most 1 MiB. Selected rules require their
  pinned bytes; duplicates, hash mismatches and missing evidence refuse.

Generating a witness or digest does not grant approval. The file is trusted
operator configuration, not protection from a process with the same OS identity.
The production entry uses shipped rules; only trusted in-process composition can
supply alternate rules. No network evidence fetch or request-selected filesystem
read occurs. Do not put private source bytes in public request examples or logs.

The caller acquires the existing physical-store `.write.lock` with Linux flock,
checks its path/inode and the approved database witness, rereads approval after
waiting, opens an existing connection, and rechecks authority before settlement.
The core retains its immediate transaction, strict chain, exact row and receipt
checks. Approval replacement or withdrawal during the wait refuses. Revocation
is an admission check; it cannot cancel a transaction already admitted. The lock
is cooperative and does not stop unrelated writers that ignore it.

The response separates `ok`, `committed`, and `appliedNow`. Successful replay has
`committed: true` and `appliedNow: false`. A failure during settlement conservatively
reports `unknown` rather than asserting that no commit occurred. A known commit
followed by cleanup failure retains `committed: true`, `appliedNow: true`, the
settlement receipt and `failedStage: finalization`. Reconcile the run before any
retry; reversal requires a fresh independently approved manifest. Errors expose
only a fixed refusal code and stage, not source bytes, paths or private exceptions.
The connection close and lock release are both attempted even if close fails.

All responses mark anchors, exports and index `not_verified`. HTTP success proves
only database settlement, not current search results, corpus accuracy, deployment
acceptance or authorization for another run. The real-store HTTP tests cover
authentication, approval, physical substitution, multiprocess flock contention,
expiry during waiting, source and chain refusals, rollback, replay, reviewed
reversal and post-commit cleanup failure.
