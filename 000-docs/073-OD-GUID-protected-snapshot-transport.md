# Protected source snapshot transport

Status: **In development**. Owning bead: `compile-then-govern-39z.11.1.4`.
This operator interface exposes the authenticated transport in
[design 072](072-AT-DSGN-merge-sensitivity-constraint-contract.md). It does not
enroll sources, install keys, migrate stores, deploy software or activate a live
merge. The broader provenance and read-policy work remains open.

## Preconditions

Use an existing current-schema Registrar store. Source and destination database
files and their immediate directories must be owned by the invoking user and
have no group or other permissions. Inputs must be owner-private, single-link
regular files, accessed through canonical absolute paths without symlinks.
Output directories must also be canonical and owner-private. Commands never
repair permissions, create missing stores, migrate schemas or overwrite outputs.

The operator must have authority to export the source tenant and modify the
destination tenant. Filesystem ownership is a custody check, not proof of this
organizational authorization. The exported snapshot contains the active tenant's
memory content and metadata; keep it private even though terminal output contains
only counts, digests and execution status. The disclosure scanner is a bounded
deterministic control, not proof that arbitrary content is safe to share.

Provision an Ed25519 private key separately. The key file contains the lowercase
hex PKCS8 DER representation (96 hex characters). Do not put its value in command
arguments, shell history, repository files or shared logs. The CLI accepts only a
key **file path**, never a key-value flag, and never creates or discovers a key.

An independently authorized operator supplies a trusted checkpoint file. It is a
JSON array of 1–32 strict
[`TrustedSourceCheckpoint`](../apps/curator/src/merge/source-snapshot-schema.ts)
records. Each record binds source identity, source and destination tenants,
Ed25519 public key and fingerprint, exact snapshot digest and sequence, validity
window and revocation status. Verify these against the authorized source through
your trusted process. Copying a key or checkpoint supplied by an untrusted
artifact into this file would defeat the authority boundary. The exporter does
not automatically produce or install trusted pins.

## Build and invoke

From an installed Registrar checkout, run `pnpm build`. The dedicated entry point
is `node apps/curator/dist/merge/snapshot-main.js`; the workspace package also
declares the `curator-snapshot` bin. This entry point does not run the ordinary
curator's default-store or origin-key initialization.

All paths below are illustrative operator-selected private files. Execution
against a live brain requires separate rollout authorization.

### Export

Create a private JSON request containing `storePath` and `options`. Options are
`sourceId`, `sourceTenantId`, `destinationTenantId`, positive `sequence`,
`issuedAt` and `expiresAt` as ISO timestamps. The sequence and time window must
come from your authorized checkpoint process. See
[`SourceSnapshotOptions`](../apps/curator/src/merge/source-snapshot-schema.ts).

```bash
curator-snapshot export --request /private/export.json --private-key-file /private/source.key --out /private/snapshot.json
```

Export opens the source read-only, checks strict audit integrity and reads the
complete active source-tenant inventory in a transaction. It does not edit source
rows or audit receipts. It signs stored and retained effective sensitivity floors
and writes a new private artifact. Output reports its digest and item count;
neither content nor key material is printed. Export does not grant destination
trust or prove the signer is honest.

### Preview

Create a private request with `storePath` (destination), `tenantId` and
`artifactPaths` (1–32 canonical private snapshot paths).

```bash
curator-snapshot preview --request /private/import.json --checkpoints /private/trusted-pins.json --out /private/plan.json
```

Preview opens the destination read-only. It verifies source signatures against
the independently supplied checkpoints, computes admission outcomes and writes a
private review envelope. The envelope binds the physical destination database and
directory, artifact paths, checkpoint path, source/destination/policy digests and
outcomes. Terminal output returns `reviewedDigest` and planned counts. Review the
private envelope before applying; a digest detects change and is not itself a
human approval record.

The CLI uses the enabled stored destination policy. It cannot inject a policy
through the request. If no policy is enabled, mandatory disclosure and sensitivity
constraints still apply; the CLI does not install an admission policy.

### Apply and reconcile

```bash
curator-snapshot apply --plan /private/plan.json --digest REVIEWED_DIGEST --checkpoints /private/trusted-pins.json
```

Apply requires the same explicit checkpoint-provider path used for preview. It
acquires the destination's shared Linux `.write.lock` via `flock`, verifies the
physical store, reads bounded private artifacts and owns the SQLite write
transaction. The checkpoint file and physical-store/lock witness are checked
inside import verification and again at finalization. Changed destination state,
policy, source evidence or authority refuses. A file update with the same trusted
pins can be accepted; a changed or revoked applicable pin cannot silently replace
the reviewed authority. The final observation is not a distributed revocation
lease and cannot discover an authority update absent from the supplied file.

Lock waiting defaults to 8 seconds; `--lock-timeout-ms` accepts an integer from 0
through 30000. No lock-file deletion or stale-lock repair is performed.

Success reports `committed: true` for a new settlement, including an import whose
policy rejects every candidate but retains restriction receipts. Exact replay
reports `alreadyApplied: true`, `committed: false` and historical settlement counts.
These counts do not assert that previously promoted memories are still active.
Older sequences or same-sequence changed artifacts refuse.

Failures return a nonzero exit and a sanitized JSON error. Once apply starts, an
exception may conservatively report `committed: "unknown"`; a post-commit failure
may report `committed: true`. Never interpret either as proof of rollback. Use a
new read-only preview with the same artifacts and still-valid authorized pins to
observe `alreadyApplied`, and inspect the durable settlement receipts when
reconciling uncertain operations. Do not weaken or replace trust to force a replay.

Anchoring, filesystem exports and search indexing are **not performed**. The
command reports those post-commit states as `not_verified`. Existing indexing and
read-policy integration must be assessed separately before live adoption.

## Library and legacy boundary

The curator package exports `exportSourceSnapshot`, `verifySourceSnapshot`,
`previewSourceImport`, `applySourceImport`, their schemas/types and
`runSnapshotCommand`. Library callers provide trusted checkpoint and clock
callbacks plus repositories sharing one connection. They own authorization,
physical-store custody and operational locking when using the lower-level API.
Apply refuses an enclosing transaction. See design 072 for transactional bounds.

Existing `mergeGovern` remains available for compatibility and is documented as
deprecated **legacy unverified source transport**; `legacyMergeGovern` is its
explicit alias. `curator-cli merge-govern` retains its invocation and behavior,
but human-readable output labels the legacy boundary and JSON includes
`transport: "legacy-unverified"`, `source_constraints_verified: false`.
A signed destination anchor does not authenticate omitted source restrictions.
Protected commands refuse bare rows, stripped signatures and altered floors;
there is no fallback to legacy merge.

## Verification scope

Disposable source snapshot tests cover signing, complete inventory, scope,
checkpoint mismatch and strict integrity. Transactional import tests cover
ordering, policy, source/destination floors, pending and audit-only aliases,
retention fault rollback, replay and later human-role review. CLI tests spawn the
actual compiled executable for export, preview, apply, replay and refusal paths;
legacy CLI tests assert the compatibility label. These tests do not establish
live source enrollment, independent checkpoint freshness, operator authorization,
deployment or end-to-end retrieval after an import.
