# 037-AT-DSGN — qmd-adapter source/index separation

**Status:** Accepted (2026-05-31)
**Type:** Architecture Decision Record
**Bead:** `qmd-team-intent-kb-e3q` — _Bridge git-exporter output layout to qmd-adapter collection paths so edge-daemon index-update actually indexes curated memories (demo stages 5-6)_
**Supersedes/relates:** `015-AA-AACR-phase3-adapter.md`, `027-OD-OPSM-edge-daemon-runbook.md`

## Context

The edge-daemon cycle is `ingest → curate → export → index-update`. Two
components on that chain had drifted out of agreement, so a curated memory could
be exported but never become searchable:

1. **git-exporter** writes curated memories to
   `<exportDir>/{decisions,curated,guides,archive}/<id>.md`
   (`apps/git-exporter/src/formatter/directory-mapper.ts` maps category +
   lifecycle → subdir).

2. **qmd-adapter** registered its five `kb-*` collections at
   `getQmdTenantIndexPath(tenant)/{kb-curated,kb-decisions,kb-guides,kb-inbox,kb-archive}`
   — a **different base path** _and_ **different subdir names** from what the
   exporter writes.

Result: `ensureCollections()` pointed qmd at directories git-exporter never
populated, and `qmd update` indexed empty/nonexistent dirs. `qmd search`
returned nothing — demo stages 5–6 could not surface a curated memory.

Two further defects compounded the disconnect, both rooted in the adapter never
having been exercised against a real qmd 2.0.1 binary:

- **`--data-dir` does not exist in qmd 2.0.1.** `RealQmdExecutor` prepended
  `['--data-dir', dataDir, ...args]` to every invocation; qmd rejects the
  unknown flag, so _every_ adapter command failed.
- **The search parser assumed tab-separated output.** qmd's default `search`
  output is a human-readable block, not `score\tfile\tsnippet`. `adapter.query()`
  parsed zero results even when qmd found matches.

## Decision

**Option A — keep git-exporter's category layout as the source of truth; teach
the qmd-adapter to index it.** The exporter owns the _content layout_; the
adapter owns the _index_. Three coordinated changes:

1. **Collection source = export tree.** Each `kb-*` collection carries a
   `sourceSubdir` (`collection-registry.ts`) naming its git-exporter subdir:

   | collection     | sourceSubdir | in default search |
   | -------------- | ------------ | ----------------- |
   | `kb-curated`   | `curated`    | yes               |
   | `kb-decisions` | `decisions`  | yes               |
   | `kb-guides`    | `guides`     | yes               |
   | `kb-archive`   | `archive`    | no                |
   | `kb-inbox`     | `null`       | — (not exported)  |

   `ensureCollections(exportBaseDir)` registers each exportable collection at
   `<exportBaseDir>/<sourceSubdir>` under its `kb-*` name. The adapter facade
   `mkdir -p`s each subdir first, so empty categories (e.g. no archived
   memories) register cleanly rather than failing `qmd collection add`.

   The collection **name** (`kb-curated`) is preserved — search-scope
   enforcement and the `qmd://<name>/...` citation both key off it — while the
   **source path** moves to the exporter's subdir.

2. **Per-tenant isolation via XDG, not `--data-dir`.** `RealQmdExecutor` takes
   an `env` override merged over `process.env`. `getQmdTenantEnv(tenant)` points
   `XDG_CONFIG_HOME` (qmd's collection registry) and `XDG_CACHE_HOME` (qmd's
   BM25 index) at tenant-scoped subdirs of the tenant index path. This isolates
   tenants from each other _and_ keeps the team KB's qmd state out of the
   operator's personal `~/.config/qmd` / `~/.cache/qmd`. **Both** XDG vars are
   required — setting only the cache var leaks `collection add` entries into the
   operator's global registry.

3. **Parse qmd `--json`.** The search client requests `search --json` and parses
   the structured array (`{file, score, snippet, ...}`), tolerant of empty /
   malformed output (degrades to "no results", never throws).

`kb-inbox` is no longer registered as a qmd collection: unreviewed candidates
live in SQLite pre-governance and are never written to the export tree. The
`inbox` search scope consequently returns nothing from qmd — correct, since
nothing pre-governance is indexed.

## Alternatives considered

- **Option B — git-exporter writes into the qmd collection source dirs
  directly.** Rejected: couples the exporter to the adapter's index layout and
  forces the `kb-*` naming into the content tree.
- **Option C — a bridging sync step in edge-daemon** that copies export output
  into collection source dirs before `qmd update`. Rejected: an extra copy of
  every memory on every cycle, plus a third place for paths to drift.

Option A keeps a single content tree (the exporter's) and makes the adapter a
pure consumer of it.

## Consequences

- **edge-daemon wiring:** `main.ts` constructs
  `new QmdAdapter({ tenantId, exportDir: resolve(config.exportOutputDir) })` —
  the adapter and exporter now share one resolved export path.
- **Coupling to document:** the `sourceSubdir` values are the git-exporter
  output contract and MUST track `getCategoryDirectory` / `getDirectory` in
  `directory-mapper.ts`. The coupling is commented at both ends and asserted in
  `collection-manager.test.ts`.
- **Proof:** `packages/qmd-adapter/src/__tests__/adapter-qmd-integration.test.ts`
  drives the real qmd binary through the production adapter (curated memory in
  `curated/` → `ensureCollections` → `update` → `query` → `qmd://kb-curated/...`
  citation) and verifies per-tenant isolation. Skipped when qmd is absent so CI
  without qmd stays green; runs locally and anywhere qmd 2.0.1+ is installed.
- **Validation constraint (unchanged):** a _full-green_ `demo-e2e.sh` run still
  needs a real `ANTHROPIC_API_KEY` so stages 1–2 produce non-empty wiki/spool
  content (ICO bead `u0j`). The adapter fix is independently verified with
  hand-crafted curated memories, no key required.

- Jeremy Longshore
  intentsolutions.io
