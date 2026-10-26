# Reviewed recovery command

`curator-recovery` exposes finite same-store recovery through a private reviewed
plan. It composes canonical intake, selected governance and conditional source
archival. Database settlement is one phase; anchoring, export reconciliation and
index refresh remain separate required work under the parent recovery bead.

## Prepare and review

Build from the registrar repository root with `pnpm build`. The compiled entry
is `node apps/curator/dist/recovery/main.js`; `--help` lists the interface.
The commands have no default store or implicit origin-key lookup.

Prepare an owner-only JSON request in a private directory. Its fields are the
`RecoveryPlanInput` contract in
[recovery-plan.ts](../apps/curator/src/recovery/recovery-plan.ts): a UUID `runId`,
explicit fresh `createdAt`, canonical absolute `storeLocator`, source and target
`TenantId` values, one to one hundred `selections`, an explicit `exclusions` array,
human `actor`, declared `admin` or `owner` role and a review reason. Each selection
and exclusion contains `id` and the full memory `snapshotDigest` computed by
`memorySnapshotDigest`. The caller establishes actual standing in both tenants;
a declared actor or digest does not authenticate an operator.

The directory and database must already exist, be owner-private and have
canonical paths without symlink components. The database must be a single-link
regular file with the complete current migration list. Opening it never creates,
migrates or chmods a store. Inputs must be owner-only, single-link regular files;
FIFO and symlink inputs are refused. The request is bounded to 1 MiB, keys to
4096 bytes and plan artifacts to 64 MiB. The output directory must be private and
existing; an existing output path is never replaced.

On a deliberately prepared private fixture, supply the reviewed paths:

```bash
node apps/curator/dist/recovery/main.js plan \
  --request /absolute/private/request.json \
  --out /absolute/private/reviewed-plan.json
```

For fresh origin attestations, also supply `--origin-secret-file PRIVATE_KEY`
and `--origin-channel CLAIM`. Planning reads that explicit key without permission
repair. Without both options the plan is explicitly unattested; it retains the
canonical admission behavior. No environment variable or default key loader
provides a fallback.

Review the private artifact, including source snapshots, exclusions, target
policies, generated proposals, sensitivity floors and physical store witness.
Retain the returned `reviewedDigest` independently. It binds the entire envelope,
including directory/database device and inode, as well as the inner plan. The
artifact contains source bodies and possibly HMAC tokens: keep it private.

## Apply and inspect

```bash
node apps/curator/dist/recovery/main.js status \
  --plan /absolute/private/reviewed-plan.json --digest REVIEWED_DIGEST
node apps/curator/dist/recovery/main.js apply \
  --plan /absolute/private/reviewed-plan.json --digest REVIEWED_DIGEST \
  --origin-secret-file /absolute/private/origin.key --lock-timeout-ms 8000
```

`status` and `plan` do not acquire or create `.write.lock`. Apply requires Linux
and `/usr/bin/flock`, holding an inherited descriptor for the existing brain lock
protocol at `<database-directory>/.write.lock`. It never unlinks that lock file.
The default timeout is 8000 ms; accepted values are integers from 0 to 30000 ms.
Store and lock witnesses are checked before application and after settlement.
Canonical data, policy, receipt and snapshot checks remain authoritative inside
one immediate transaction. No unrelated inbox or spool sweep is performed.

All stdout is JSON. Successful apply returns `committed`, `alreadyApplied`,
per-entry `status` and fixed diagnostic codes in `warnings`. A dormant policy
produces `dormant_policy_rules` without printing its private name or id. Existing
Curator callers retain their normal policy warning unless they supply the
optional diagnostic sink. Canonical rule outcomes are unchanged.

A database status of `complete` means selected database recovery settled. Every
command still reports `recoveryComplete: false`: apply reports anchor, exports
and index as `pending`; status reports them as `not_verified`. Exit zero can also
accompany a legitimate `partial` result. Held, flagged or refused entries retain
their sources; later human admission needs a separately reviewed finalization.

On refusal, exit status is one and output uses `recovery_refused` without raw
exceptions. `committed: false` means application had not started; `unknown` means
it started but did not return settlement evidence. An output failure after a
known commit reports `committed: true`. Inspect status and canonical receipts
before retrying. An unchanged settled plan replays without writes; drift refuses
replay. Unexpected transactional failures roll back source and target changes.

## Trusted asynchronous integration

`executeRecoveryEnvelope` is the public programmatic boundary for a fixed
integration that needs the recovery store’s kernel flock during asynchronous
postprocessing. It takes `operation: apply | repair`, the private `planPath`, an
independently supplied `expectedDigest`, optional explicit `originSecretFile` for
apply and optional `lockTimeoutMs`. The lock helper validates an integer timeout
from zero through 30,000 milliseconds. Repair refuses key inputs. This API adds no
CLI shell hook or automatic operation on import.

A fresh committed apply, including a legitimate partial outcome, runs the awaited
trusted callback. Apply replay skips it. Explicit repair requires an existing,
non-drifted apply receipt and performs no intake, governance or archival. The
callback receives the existing database capability, fixed run/digest/tenant/store
identities, a copied settlement status, sanitized warning codes and
`assertStillBound()`. It receives no source body, HMAC or key field. The database
is a trusted programmatic capability; this is not a sandbox for untrusted code.

A future fixed integration must call `assertStillBound()` between external stages.
The boundary also checks centrally after callback completion, comparing against
its own settlement authority. Operation identity is captured before await, so
caller mutation cannot relabel the result. The boundary retains the connection
and acquired lock through the callback and attempts both close and release during
cleanup. Path replacement is detected at the next binding check; holding a file
descriptor does not prevent replacement. A future integration must await every
writer’s termination before returning. This API provides no callback timeout or
child-process termination enforcement.

The optional third argument, `TrustedRecoveryReadiness`, lets a fixed integration
check prerequisites before a fresh apply. It runs synchronously under the same
kernel flock, connection and outer `BEGIN IMMEDIATE` as the nested canonical
application. This prevents another SQLite writer from changing the checked state
between readiness and application. Refusal before application returns
`committed: false`, `appliedNow: false` and `failedStage: preflight`; the outer
transaction rolls back any writes attempted by a refusing checker. The checker
receives store/run/tenant bindings and `assertStillBound`, with no settlement
snapshot because settlement does not yet exist.

This is trusted programmatic code, not a sandbox or user-configured hook. It must
read only, return `undefined` and schedule no asynchronous work. Native async
functions are refused before invocation; any non-undefined return also refuses.
These checks cannot prevent trusted code from scheduling detached work. Do not
pass an untrusted callback. The synchronous CLI does not expose this capability.
Existing integrations with two arguments retain their behavior.

Readiness is for fresh application only: an existing apply replay skips it and
still reports historical settlement with `skipped_replay`. Repair does not invoke
it or reapply governance; the fixed postcommit integration must verify current
readiness there, retaining `committed: true` when it refuses a known settlement.
Pre-application readiness never replaces strict postcommit verification.

For a bounded descriptor read, store exports `parseAnchorLog(snapshot)` and
`verifyAnchorRecords(auditRepository, records)`. These reuse the canonical JSONL
parser and the same anchor-verification loop as `readAnchors` and `verifyAnchors`.
The snapshot verifier reads no filesystem path and recomputes the audit chain
from the supplied repository. Existing path APIs retain their existing read
behavior. The caller must bound the original read, establish file and directory
identity, retain independent pins and recheck bindings; neither snapshot function
establishes provenance, external publication or a filesystem read limit. Forks
and anchor mismatches retain their existing verdicts.

For this async API, `committed: true` means the core application returned a
settlement or an existing non-drifted settlement was re-read. It includes a
historical apply and does not establish storage durability after power loss.
`appliedNow` identifies a new memory transaction in this invocation. Refusals
detected before the core application starts report false; errors raised inside
the core application and repair of drifted settlement report unknown. Callback/cleanup failures
retain a known commit and return a sanitized `failedStage`. Failure results do
not present an old settlement snapshot as a fresh status proof. The synchronous
CLI retains its existing per-invocation commit reporting.

`postcommit.state: completed` describes callback completion only. The generic
boundary always returns `recoveryComplete: false`, even if a callback returns a
value claiming success. The callback’s value is passed through verbatim: the
integrator must sanitize it. Only the boundary’s own error fields omit raw
exceptions; the database capability permits trusted code to read private data.
Concrete plugin anchor/export/index integration must
establish its own evidence: both source and target tenant exports, tenant-exclusive
index roots, actual selected qmd command provenance and explicit postcommit repair
without new governance receipts. That integration and the private-copy rehearsal
remain open under the parent recovery work.

## Completion and rollback boundaries

This command does not yet execute postcommit anchor/export/index work. It grants
no live recovery approval and does not prove runtime/tenant binding or a
restore-checked backup. The parent recovery work must complete those requirements
and a source-bound private-copy demonstration before any approved live run.

Before settlement, a refused plan leaves database rows unchanged. After a known
commit, rollback requires a restore procedure and backup reviewed for that run;
do not undo recovery by deleting receipts or rewriting the audit chain. Local
audit evidence is tamper-evident.

The command tests exercise compiled child processes over private synthetic stores,
including special-file refusal, physical path replacement, independent kernel
lock contention, read-only modes, private output, partial governance, fault
rollback and identical-plan replay. These fixtures are not a live-corpus rehearsal.
