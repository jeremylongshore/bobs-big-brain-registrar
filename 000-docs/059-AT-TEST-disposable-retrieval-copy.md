# Disposable copied-corpus retrieval acceptance

The explicit retrieval test builds fresh derived indexes over an internally
owned copy of configured exports. The helper excludes source qmd/native indexes,
state databases and registries from copying and worker routing. Its report describes retrieval from the copied corpus,
not bitwise reproduction of an existing live index. The ordinary default-lane
isolation and the separate dense/rerank lanes retain their existing behavior.

## Ownership and execution

`TEAMKB_TEST_LIVE_BASE_PATH` identifies a source with `kb-export/`; an existing
source index is unnecessary. The exact retrieval opt-in, tenant and absolute
trusted qmd executable remain required. The helper requires Linux process
identity witnesses and refuses unsupported environments before copying.

Preparation creates an exclusive private temporary root. Only regular Markdown
exports in the five canonical export collections are copied, using independent
files with mode 0600 under private 0700 directories. Symlinks, special files,
unexpected filenames, invalid ancestors and changed file metadata are refused.
Per-file descriptor/name checks and bounded reads do not create an atomic
cross-file source snapshot; a consistent export view remains the caller's input.
Reads can affect source access metadata.

The copy excludes source state databases, qmd/native SQLite files and WALs,
registries, credentials and model caches. A worker starts with private HOME,
XDG/config/cache paths, INDEX_PATH, QMD_CONFIG_DIR and cwd before its first binary
probe or adapter import. Explicit adapter base/export paths and executor tenant
base paths route derived writes to that copy. Canonical collection/reindex APIs
build a fresh registry referencing copied paths instead of reusing absolute
paths from the source registry. The query dataset and report assertions remain;
the backend label is `copied-corpus-qmd-native`.

The executable is explicitly trusted and is not prevented from independently
accessing the source tree. Private directories and environment routing
are not a sandbox against arbitrary executable code or another process running
as the same user. No new production resolver, adapter, retrieval ranking or
schema behavior is introduced by this test-only helper.

## Bounds and cleanup

Copy preparation limits exports to 2 GiB total, 16 MiB per file, 100,000 files and
8 nested directory levels. Derived index files consume additional space; 2 GiB is
not a bound on total temporary disk use. The helper uses a 120 second work deadline
plus up to 8 seconds for a terminal ownership decision. The explicit suite allows
150 seconds for fresh indexing and teardown. Copy-time checks are cooperative
and cannot interrupt blocking filesystem I/O; these bounds are not a hard
wall-clock guarantee under a stalled filesystem.

A successful worker reports zero tracked qmd groups and exits, closing its cached
native handles. After worker closure, the parent checks the report envelope and runs the
configured caller validator before deleting its exact owned root. The explicit
retrieval suite supplies all existing dataset/report assertions as that validator;
a failed semantic assertion retains scratch. Other callers without a validator
receive only the helper's minimal envelope check. Preparation failures remove only the
partial owned copy. Nonzero worker exit, invalid envelope or caller validation failure, worker timeout
or detected process ownership uncertainty retains scratch and returns its exact path for investigation. Worker
closure alone is not evidence that every detached descendant is gone. This test
adds no automatic purge or deletion capability for caller-supplied paths.

## Run deliberately

From the repository root:

```bash
TEAMKB_TEST_LIVE_RETRIEVAL=1 \
  TEAMKB_TEST_LIVE_BASE_PATH=/absolute/approved/source \
  TEAMKB_TEST_LIVE_TENANT_ID=approved-tenant \
  TEAMKB_TEST_LIVE_QMD_BIN=/absolute/approved/qmd \
  pnpm exec vitest run --config vitest.live.config.ts eval-retrieval-live
```

Missing configuration, an empty/unreadable export set or unavailable executable
fails the requested run. A copied report does not certify a live index's contents,
performance or readiness, and no model service is enabled by this retrieval lane.

## Hermetic controls

The helper tests cover independent bytes/inodes/modes, ignored source databases
and registry paths, source aliases and symlinks, FIFO refusal, interrupted-copy
cleanup, no-probe invalid configuration, missing PID witnesses, invalid code-zero
reports and bounded uncertainty without guessing a PID. The actual worker runs
with a fake qmd executable to inspect private environment/arguments and canonical
collection paths. Known synthetic failure fixtures remove their captured roots
only after their own worker has stopped; they do not generalize that cleanup to
unknown executables.

The entry-point control invokes the actual explicitly enabled retrieval suite
against synthetic source indexes, registry and database sentinels. It requires
all dataset/report assertions to pass, source bytes/inodes/mtime to stay the
same, the source native index to remain absent and the worker's scratch to be
removed. An author-local earlier source-routing run used the same real test lane
with synthetic inputs and observed a newly created source native SQLite file;
the [published proof projection](https://github.com/jeremylongshore/bobs-big-brain-registrar/pull/408#issuecomment-6403873461)
records the command, observation and artifact digests.
These controls exercise ownership, not live-corpus retrieval quality or a security
sandbox. Default collection and missing-configuration sentinel tests remain in
`tests/support/live-test-isolation.test.ts`.
