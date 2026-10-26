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

## Completion and rollback boundaries

This command does not yet execute postcommit anchor/export/index work. It grants
no live recovery approval and does not prove runtime/tenant binding or a
restore-checked backup. The parent recovery work must complete those requirements
and a source-bound private-copy demonstration before any approved live run.

Before settlement, a refused plan leaves database rows unchanged. After a known
commit, rollback requires the separately reviewed restore procedure and backup;
do not undo recovery by deleting receipts or rewriting the audit chain. Local
audit evidence is tamper-evident.

The command tests exercise compiled child processes over private synthetic stores,
including special-file refusal, physical path replacement, independent kernel
lock contention, read-only modes, private output, partial governance, fault
rollback and identical-plan replay. These fixtures are not a live-corpus rehearsal.
