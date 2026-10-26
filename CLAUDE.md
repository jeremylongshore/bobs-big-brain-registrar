# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

**Bob's Big Brain Registrar** — a governed team memory platform for Claude Code powered by qmd. TypeScript/Node.js monorepo providing orchestration, governance, lifecycle management, and team-shared memory for Claude Code sessions.

**Renamed 2026-07-19:** the GitHub repo is now `jeremylongshore/bobs-big-brain-registrar` (formerly `jeremylongshore/qmd-team-intent-kb`; old URLs 301-redirect). Deliberately UNCHANGED: the `@qmd-team-intent-kb/*` npm scope, the `ghcr.io/jeremylongshore/qmd-team-intent-kb-edge-daemon` image name, and all `qmd-team-intent-kb-*` bead IDs — those are artifact identifiers, not the repo name. The sibling compile engine is now `jeremylongshore/bobs-big-brain-compiler` (formerly `intentional-cognition-os`).

**This is not**: a qmd fork, not git-as-database, not prompt-only memory governance.

## Architecture Thesis

1. Claude Code proposes memory candidates during sessions
2. Deterministic code (not LLM judgment) decides what becomes durable team memory
3. qmd serves as the local retrieval/index edge engine
4. A canonical memory control plane owns truth, lifecycle, governance, dedupe, and analytics
5. Git is a mirror/export/distribution layer, not the canonical database
6. Default search targets curated knowledge only
7. Inbox/archive content must not pollute default search

## Testing SOP (Intent Solutions)

Current enforcement is owned by `tests/TESTING.md`, `.husky/`, `scripts/harness-pin.sh`, and the checked-in workflows. The `@intentsolutions/audit-harness` dependency is installed; repository-specific policy pinning uses `pnpm harness-pin`, not the generic upstream manifest. Changing policy still requires its normal review and visible re-pin.

The 2026-04-21 grade-C audit (119 test files and no enforcement) is historical. It does not describe the current coverage, architecture, policy-pin, secret-scan, or eval gates. See `tests/TESTING.md` for the dated audit history and `.github/workflows/ci.yml` for current commands. A documented gate is not a claim that a particular run passed.

## Build Commands

```
pnpm install --frozen-lockfile # Install pinned workspace dependencies
pnpm validate         # Run format:check + lint + typecheck + test (local aggregate; CI runs individual gates)
pnpm lint             # ESLint across all packages
pnpm format           # Prettier format
pnpm format:check     # Prettier check without writing
pnpm typecheck        # TypeScript type checking (tsc -b composite build)
pnpm test             # Run all Vitest tests
pnpm test:watch       # Vitest in watch mode
pnpm clean            # Remove all dist/build artifacts
```

To run a single test file:

```
pnpm vitest run packages/schema/src/__tests__/enums.test.ts
```

To run tests for a single package:

```
pnpm vitest run packages/schema/
```

To run apps in dev mode (any app with tsx watch):

```
cd apps/api && pnpm dev    # tsx watch src/main.ts
```

## Architecture & Data Flow

### Information Flow (the critical path)

```
Claude Code session
  → claude-runtime captures memory candidates, applies secret scanning
  → writes to local spool directory
  → curator reads from spool, runs policy-engine evaluation pipeline
  → passes: promoted to curated memory in store (SQLite)
  → fails: rejected with audit trail
  → git-exporter detects changes, writes Markdown+frontmatter to kb-export/
  → qmd-adapter indexes curated memories for local search
  → api exposes control plane for CRUD, search, lifecycle transitions
  → reporting generates analytics from store data
```

### Dependency Graph

```
schema (Zod domain model — base of everything)
  └→ common (Result<T,E>, hashing, paths)
       ├→ claude-runtime (capture, spool, secret detection)
       │    └→ policy-engine (10 deterministic rule evaluators)
       │         └→ api (Fastify REST) + curator (promotion pipeline)
       ├→ store (SQLite via better-sqlite3, 8 repository classes)
       │    └→ api + curator + git-exporter + reporting
       └→ qmd-adapter (CLI wrapper, search, index lifecycle)
            └→ api (search delegation)
```

Packages import UP this graph only — never circular. `schema` and `common` have no internal deps.

### Domain Model (packages/schema)

Core types defined as Zod schemas with derived TypeScript types:

- **MemoryCandidate** — Raw proposals in the inbox (status: inbox)
- **CuratedMemory** — Promoted, governed knowledge with lifecycle state
- **GovernancePolicy** — Configurable rule sets per tenant
- **AuditEvent** — Tamper-evident governance trail; search accesses are logged separately
- **SearchQuery/SearchResult** — Typed search with scope control

Key enums: `MemoryLifecycleState` (active/deprecated/superseded/archived), `Sensitivity` (public/internal/confidential/restricted), `MemoryCategory`, `TrustLevel`, `CandidateStatus`, `SearchScope`

**Claim-level audience** (K2, decision `000-docs/053-AT-DECR`): `ContentMetadata.audience` is an OPTIONAL closed enum (`Audience`: `tenant` | `admins` | `owner`) saying who inside a tenant a claim is for. It extends `tenantId` and `sensitivity`, replaces neither, and lives in the JSON-validated `metadata_json` column (no DB column, no CHECK, no migration). Absent means `tenant`, so pre-K2 rows behave exactly as before. It is declared at capture on the candidate and carried by promotion; no rule infers it and no model writes it. Enforcement is the pure predicates in `packages/common/src/audience.ts` (fail-closed on an unknown audience or role): the API filters search, memory reads and graph reads by the caller's read standing (`member` < `admin` < `owner`; owner = an admin token with `"owner": true` in `tokens.json`, or loopback dev no-auth; the legacy shared key is admin, not owner), and the git-exporter writes ONLY `tenant`-audience memories to the shared export tree. Consequence: `admins`/`owner` memories are not in the qmd index, so they are reachable by id/list and the SQLite search fallback, not by qmd-cited search, until per-audience indexes exist.

**Governed narrowing and redaction** (K3, runbook `000-docs/054-OD-RNBK`): two post-promotion writes, each with a hash-chained receipt in the same transaction as the change. `narrowAudience` (`apps/curator/src/audience/`, `curator-cli narrow-audience`, `POST /api/memories/:id/narrow-audience`) moves a memory to a STRICTLY narrower tier and refuses widening (that is K4); the order is `validateAudienceNarrowing` in `packages/common/src/audience.ts`. `redactMemory` (`apps/curator/src/redaction/`, `curator-cli redact`) REPLACES the content of a memory that holds a secret, in `curated_memories` and every `candidates` copy, and writes `redacted` receipts with the old and new content hashes and pattern names, never the removed text. A redaction never edits an audit row, so the chain verifies as before. The CLI then runs the physical scrub (`packages/store/src/redaction-scrub.ts`: FTS rebuild, WAL truncate, `VACUUM`) and byte-scans the store files, then scrubs every tenant's derived index (below). Consequences to keep in mind: a redacted memory's id derives from its PRE-redaction hash (`provenance-walk` checks the receipts), and every dedup site must also refuse a redacted old hash (`AuditRepository.findRedactionByOldContentHash`, `CandidateRepository.isRedactedContent`). Redaction does not reach existing backups, the export tree or spool/compile artifacts.

**Derived-index scrub** (bead `compile-then-govern-39z.19`, runbook `000-docs/054-OD-RNBK` §4.7): `packages/qmd-adapter/src/scrub/`, CLI `qmd-index scrub-index [--dry-run] [--json] [--scan-fragments-file <0600 file>]`. There is one index directory PER TENANT under `<base>/qmd-index/` (`intent-solutions` for the API/CLI, `local` for the plugin's local mode — both live), and a reindex touches only one. The scrub discovers every tenant dir and reconciles its qmd BM25 cache, native FTS5 index and dense sidecar (which stores a plaintext snippet) against kb-export, drops qmd's inactive/orphan rows, rebuilds + optimizes both FTS5 indexes, then `secure_delete` + WAL truncate + `VACUUM`, and byte-scans every file for removed fragments (names and counts only). It fails closed on a qmd schema that differs from `PINNED_QMD_VERSION` (exit 5), reports a busy database by name (exit 4), and refuses a mass removal. `curator-cli redact` runs it as a CHILD PROCESS (fragments on stdin) after the DB scrub — the curator must not import qmd-adapter (seam-independence `delete-compile` gate) — and also drops the redacted memory's rows outright until the exporter rewrites it. `--skip-index-scrub` opts out. The `audience_narrowing` policy rule only recommends a tier; it is flag-only and writes nothing.

**qmd child-process ownership** (bead `compile-then-govern-39z.20`, runbook `000-docs/042-OD-OPSM`): `RealQmdExecutor` spawns qmd in its OWN process group and, on timeout, SIGTERMs the whole group (SIGKILL after 5 s) and does not resolve until the group is gone — the qmd binary is a launcher that re-execs `node qmd.js` without forwarding signals, so the old `execFile({ timeout })` orphaned a still-writing `qmd update`. A SIGINT/SIGTERM/SIGHUP to the host SIGTERMs every live group (then re-raises if the host has no handler of its own), and `exit` does the same (`executor/process-groups.ts`). Index-maintenance calls (`update`/`embed`/`cleanup`/`collection add`) get `DEFAULT_MAINTENANCE_TIMEOUT` = 600 s (`TEAMKB_QMD_TIMEOUT_MS`, or `qmd-index reindex --timeout-ms`); interactive calls keep `DEFAULT_TIMEOUT` = 30 s. Failures go through `describeQmdFailure` — timeout / exit code + stderr tail / signal / output overflow / spawn error are distinct, never one opaque "Failed to …".

**Human-escalation hold** (K6, runbook `000-docs/055-OD-RNBK`): an audience or secret question the rules can detect but not decide puts a candidate on a BOUNDED hold in place of promoting or dropping it. It reuses the 014-AT-DECR recommend / pipeline-owns split and the existing `quarantined` status: a hold is `quarantined` plus a `held` audit receipt carrying the triggers and `expiresAt` (no new status, no migration). Entry is a deterministic rule outcome only (`evaluateHoldTriggers` in `packages/policy-engine/src/hold/`: an `audience_narrowing`, `sensitivity_gate` or flag-action `secret_detection` flag, or a `member` proposal declaring `admins`/`owner`), applied by `Curator.processSingle` (outcome `held`) and by `POST /api/candidates/:id/promote` (422 `held_for_review`). A model may attach a recommendation (`recommendOnHold`, `POST /api/holds/:id/recommend`), which writes one receipt and changes nothing. A PERSON with admin or owner standing resolves (`resolveHold` in `apps/curator/src/hold/`, `curator-cli holds resolve`, `POST /api/holds/:id/resolve`; agent tokens are refused): release re-runs the whole gate and promotes with the audience the person chose, reject retires the candidate. Bounds: 14 days then the hold closes UNPROMOTED (`TEAMKB_HOLD_TTL_DAYS`), 100 open holds per tenant then the gate fails closed (`TEAMKB_HOLD_MAX_ACTIVE`). Every change commits with its hash-chained receipt in one transaction. A release resolves only the flags a hold covers; any other flag still refuses it.

**Lifecycle state machine** (`packages/schema/src/lifecycle.ts`):

```
active → [deprecated, superseded, archived]
deprecated → [active, archived]
superseded → [archived]
archived → [] (terminal)
```

### Store (packages/store)

SQLite via better-sqlite3 with 8 domain tables: `candidates`, `curated_memories`, `governance_policies`, `audit_events`, `export_state`, `memory_links`, `import_batches`, and `index_state`, plus `schema_migrations` bookkeeping. Eight repository classes own those domain tables. Use `createTestDatabase()` for in-memory test databases.

### Policy Engine (packages/policy-engine)

`PolicyPipeline` composes rules and short-circuits on first failure. Rules are registered in `RULE_REGISTRY` keyed by `PolicyRuleType` enum. Current rules: secret-detection, content-length, source-trust, relevance-score, dedup-check, tenant-match, sensitivity-gate, content-sanitization, contradiction-check, audience-narrowing (flag-only, K3).

**Supersession** (`packages/policy-engine/src/supersession/`): `planSupersession` is pure and read-only. Primary path is SUBJECT-KEYED: a candidate declaring `metadata.subjects` retires every active same-tenant memory sharing a subject key, across categories, but only when the candidate is authoritative (`decision`/`architecture`/`convention`) or the target is its own category; a memory promoted after the candidate was captured is never retired. Fail-safe: more than `DEFAULT_MAX_SUPERSEDES_PER_PROMOTION` (25) matches retires NOTHING (total across the candidate's subjects) and the Curator reports it as blocked (the API promotion path skips it without a report yet); the Curator adds a per-run budget (`maxSupersedesPerRun`, default 200) and a `supersessionMode: 'report'` dry-run. Un-keyed memories fall back to same-category title-Jaccard near-duplicate collapse (never cross-category). Existing memories need `metadata.subjects` backfilled before a decision can retire them.

### API (apps/api)

Fastify 5 with dependency injection via `buildApp(deps: AppDependencies)`. Middleware registration order: rate-limiter → api-key-auth → write-gate → tenancy-guard → capture-quota → input-sanitizer. OpenAPI is registered before route loading. Route families: `/api/candidates` (including promote/reject), `/api/holds` (recommend/resolve), `/api/memories` (by-hash, transition, narrow-audience, recategorize), `/api/policies`, `/api/audit` and `/api/audit/receipt-tip`, `/api/search`, `/api/import` (preview/batches/rollback), `/api/auth/revoke`, `/api/auth/revoke-actor`, and `/api/health`. Graph reads are `GET /api/memories/:id/neighbors` and `GET /api/memories/:id/graph`. See `apps/api/src/routes/` for exact methods and schemas.

#### Cited-query report (brain adoption KPI)

`POST /api/search` emits one structured `query-access` access-log line per read (`{ actor, query, scope, resultCount, citations }`) — deliberately a log line, _not_ a governance `AuditEvent`, so the hash-chained trail stays pure for `ico audit verify`. `apps/api/src/reports/` aggregates those lines into the **weekly cited-query count per teammate** (a _cited_ query = one that returned ≥1 `qmd://` citation):

```bash
pnpm build                              # produce apps/api/dist
pnpm report:cited-queries               # last 7 days, human table
pnpm report:cited-queries --days 30 --json   # JSON for the notification hub
```

The aggregator (`cited-queries.ts`) is pure and source-agnostic; the CLI (`weekly-cited-queries-cli.ts`) is the only piece that reads the systemd **user** journal (`teamkb-brain-api.service`, persistent journald = the durable access log). `--stdin` pipes lines from any source instead. Intended to run weekly via cron or the notification hub.

### Curator (apps/curator)

Orchestrates the full promotion pipeline: spool intake → policy evaluation → dedup check (content hash) → human-escalation hold (K6) → subject-keyed supersession (same-category title-Jaccard fallback for unkeyed memories) → promote or reject. Supports dry-run mode.

**Secret sweep** (`curator-cli secret-sweep --db <path> --tenant <id> [--pattern <id>]... [--json]`, `apps/curator/src/secret-sweep/`): read-only whole-brain re-run of `scanTextForSecrets` (policy-engine — the same function the `secret_detection` rule calls) over every curated memory in every lifecycle state. Output is id, title, lifecycle, category and pattern names only — never matched text. Exit 0 clean · 3 findings · 2 usage · 1 I/O. Secret patterns live in `packages/claude-runtime/src/secrets/patterns.ts`; a pattern may carry an `accept` value predicate (placeholder exclusion) that the scanner and the redactor both honour.

### Git Exporter (apps/git-exporter)

Incremental export of curated memories to `kb-export/` as Markdown with YAML frontmatter. Category-based directory routing (decisions/, curated/, guides/, archive/). Tracks last export timestamp via `ExportStateRepository`. **Reconcile mode** (`runExport` config `reconcile: true`, `exporter-cli export --reconcile`) ignores that watermark and converges the whole tree on the DB — it is how lifecycle changes made outside a promotion (curator `batch-transition`) reach disk. Content-compared (idempotent, repairs torn/deleted files); orphan removals are capped (`maxOrphanRemovals`, default 50) and only touch files whose frontmatter tenant matches. The plugin's `brain_govern` uses it every run.

### qmd binary discovery (packages/qmd-adapter)

`RealQmdExecutor` selects `qmdBinary` config → `TEAMKB_QMD_BIN` → declared owned runtime → legacy `PATH` / `~/.bun/bin/qmd`. Explicit binary strings retain verbatim spawn behavior. The legacy `resolveQmdBinary` API remains path-only; `resolveQmdCommand` returns executable, prefix and readonly selection provenance.

Owned execution is opt-in: pass `qmdRuntime: { root, manifestSha256 }` or set `TEAMKB_QMD_RUNTIME` to JSON with those two fields. The digest must come from separately reviewed artifact provenance. A declaration with invalid metadata, redirected internal files or incompatible host/Node ABI fails without legacy fallback. A source checkout alone declares no runtime. Metadata inspection and the launcher's full closure verification consume the existing command deadline. Selection metadata records the source base commit, uncommitted-candidate flag and source-file binding; it does not establish serving or portable native compatibility.

Tenant execution binds `INDEX_PATH` to `<base>/qmd-index/<tenant>/cache/qmd/index.sqlite` and `QMD_CONFIG_DIR` to `<base>/qmd-index/<tenant>/config/qmd`, preserving the existing layout. An explicit `--index index` before literal `--` disables qmd's ancestor `.qmd` discovery. Original arguments select the timeout class before prefixes/selectors: adapter 30s interactive / 600s maintenance; MCP 5s version / 120s embed. MCP uses its resolved config base for sync. Team startup and forced team sync registration never select or probe local qmd. `options.env` remains child execution environment, not discovery configuration.

## Monorepo Layout

- `apps/api/` — Control plane REST API (Fastify)
- `apps/curator/` — Memory promotion, dedupe, supersession engine
- `apps/edge-daemon/` — Local qmd sync daemon (cycle, lock, health, CLI subcommands)
- `apps/git-exporter/` — Git mirror/export service
- `apps/mcp-server/` — Local/team MCP server (11 registered tool names; role-dependent availability)
- `apps/reporting/` — Analytics and lifecycle reporting
- `packages/schema/` — Zod domain model, lifecycle state machine
- `packages/store/` — SQLite persistence layer (better-sqlite3)
- `packages/qmd-adapter/` — qmd CLI wrapper, search, index management
- `packages/claude-runtime/` — Session capture, secret scanning, spool
- `packages/policy-engine/` — Deterministic governance rule pipeline
- `packages/repo-resolver/` — Multi-repo context resolver (resolveRepoContext, tenant derivation, monorepo detection, cache)
- `packages/eval-surface/` — Governance/provenance evals
- `packages/qmd-runtime/` — Owned qmd runtime tooling
- `packages/test-fixtures/` — Shared synthetic fixtures
- `packages/common/` — Result type, hashing, path utilities

**All packages and apps are now implemented.** Edge-daemon production hardening (HTTP health, structured logging, retry/backoff, deploy artifacts) tracked under epic `qmd-team-intent-kb-1x6`.

## Code Conventions

- **TypeScript strict mode** with `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`
- **Module system**: NodeNext (ESM with `.js` extensions in imports)
- **Prettier**: single quotes, trailing commas, 100 char width, 2-space indent
- **ESLint**: typescript-eslint recommended, unused vars prefixed with `_`
- **Testing**: Vitest with co-located `__tests__/` directories, deterministic time injection via `nowFn` parameters
- **No external YAML library**: frontmatter is string-templated in git-exporter

## Testing

- Unit tests: Vitest, co-located with source in `__tests__/` dirs
- Integration tests: `tests/` directory at repo root
- Local aggregate: `pnpm validate`. PR checks run the individual commands and additional named gates in `.github/workflows/ci.yml`; do not substitute the aggregate for the complete required-check set.
- Test database helper: `createTestDatabase()` from `packages/store` for in-memory SQLite
- Temp directories via `mkdtempSync` for spool/file system tests

## CI/CD

- **ci.yml** — PRs to main and pushes to main/develop: frozen install, pinned qmd on PATH, format, lint, typecheck, architecture, CRAP, policy hash pin and coverage in `validate`; separately named `moat-evals`, `retrieval-eval`, and Docker/Testcontainers `integration` jobs. `pnpm validate` alone does not run this complete set.
- **minimax-review.yml** — Two advisory review lanes (`Review`, `Adversarial review`), configured via repository secrets/variables. A failed provider request is not a review verdict.
- **docs-quality.yml** — Markdownlint, Vale, links, and frontmatter.
- **security.yml** — Main pushes, PRs, and dispatch: npm audit and gitleaks, plus advisory Semgrep.
- **nightly.yml** — 04:00 UTC daily or dispatch: aggregate validation, build, additional evals, corpus-accounting and dependency checks.
- **release.yml** — Dispatch/tag release validation, image publication and provenance; not invoked by routine documentation edits.
- **seam-independence.yml** — Named delete-Compile, swap-model and model-free receipt-verification checks.
- **emit-evidence.yml** — Main-push/dispatch evidence publication.
- **notify-umbrella-changelog.yml** — Notify the umbrella to refresh its derived changelog.

## Retrieval and MCP inventory

The production entrypoints fuse qmd BM25, native FTS5, and a default-enabled sqlite-vec dense arm using reciprocal-rank fusion, then apply freshness and category ranking. The optional loopback embedder is separate infrastructure; unavailable dense retrieval fails open to lexical results. Direct library callers must supply dense configuration. Governance and receipt verification use no retrieval model.

The separate cross-encoder reranker is configured explicitly; freshness/category ranking is not a model call. See `000-docs/050-AT-RNBK-reranker-service-runbook.md` and `051-AT-RNBK-embedder-service-and-dense-index-runbook.md` (under `000-docs/`) for dated operational evidence. Decision 044 still conflicts with the shipped embedder selection; its dated note distinguishes observed implementation from decision authority.

`apps/mcp-server/src/server.ts` registers three read tools (`teamkb_search`, `teamkb_status`, `teamkb_neighbors`) and eight tools inside `canWrite`: `teamkb_propose`, `teamkb_import`, `teamkb_transition`, `teamkb_recategorize`, `teamkb_vault_preview`, `teamkb_vault_import`, `teamkb_vault_rollback`, `teamkb_sync`. `canWrite` defaults to the configured admin role but is an explicit server option. This is the Registrar surface, separate from the plugin's `brain_*` tools.

## Rules for Working in This Repo

### Before Starting Any Work

1. Verify whether previous work already exists — read recent commits, open PRs, branch state
2. Check comments, review feedback, and open TODOs for requested fixes
3. Address any required fixes before starting new work
4. Run `/repo-sweep` when relevant to clear stale branches/PRs

### Doc Filing (000-docs/)

- All durable documentation lives flat in `000-docs/` with `/doc-filing` convention
- Format: `NNN-CC-ABCD-description.md` (e.g., `001-AT-ARCH-repo-blueprint.md`)
- CC = 2-letter category code (AT, PP, TQ, DR, etc.), ABCD = 4-letter type code (ARCH, PLAN, TEST, etc.)
- Never create subdirectories under 000-docs
- See `000-docs/000-INDEX.md` for current inventory

### Beads Usage

- Never code without first marking a Beads task as in_progress
- Never finish work without closing the Beads task with evidence
- Always `bd dolt push` after closing
- Workflow: `bd update <id> --status in_progress` → work → `bd close <id> --reason "evidence"` → `bd dolt push`

### Git hooks and Beads

This repository keeps `core.hooksPath=.husky/_` so Husky's lint-staged and policy-hash gates remain active. The tracked `.husky/*` hooks chain into `.beads/hooks/<hook>` through `.husky/beads-hook`; do not repoint `core.hooksPath` to `.beads/hooks` or bypass the Husky gates. The beads chain is deliberately fail-open, while the repository's lint and policy verification gates remain fail-closed.

### Scaffolding vs Implemented

- Be explicit about what is currently scaffolding vs implemented
- Placeholder packages contain only package.json, tsconfig.json, and src/index.ts with a TODO comment
- Do not claim features work when they are only scaffolded
- Update `000-docs/004-PP-RMAP-phase-plan.md` when implementation status changes

### Release & Changelog

- Semantic Versioning, CHANGELOG.md in Keep a Changelog format
- Every user-facing change needs a changelog entry (Added, Changed, Fixed, Security, Deprecated, Removed)
- Use `/release` skill for release preparation

### Bulk edits — governed state is write-protected by receipts

- Read-only SQL against a store (`SELECT` over `teamkb.db`) is fine for inspection and reporting.
- WRITES to governed state go through the MCP/curator promoter path only. A raw
  `INSERT`/`UPDATE` to `curated_memories` bypasses the promoter's single-transaction
  memory-row + `promoted`-receipt write, breaking corpus accounting — the
  `curator-cli verify-corpus-accounting` guard (also run nightly in CI) will flag the
  row as an orphan and exit nonzero.

### Enterprise Mode Standards

- All code must pass lint, format, and type checks
- Follow the active review policy in `REVIEW.md` and the advisory `minimax-review.yml`; address supported findings and require the actual deterministic checks before merging.
- Security considerations documented for every new subsystem
- Dependency updates reviewed, not auto-merged

## Ecosystem positioning — INTKB is the governance layer of ICO + INTKB

INTKB is the **governance layer** of a two-layer ecosystem with `intentional-cognition-os` (ICO) as the upstream compilation layer:

```
ICO (compile) → spool → INTKB (govern, dedupe, score) → qmd (retrieve) → MCP/REST
```

The canonical reference for this positioning is the peer-reviewed thesis paper:

- `000-docs/034-AT-NTRP-ecosystem-thesis.md` — **"Compile, Then Govern: A Two-Layer Local-First Architecture for Team Institutional Memory"** (2026-05-23). The Compiler maintains its own copy at `000-docs/034-AT-NTRP-ecosystem-thesis.md`; the copies have diverged and are not byte-identical. Cross-repo epic: bead `qmd-team-intent-kb-oaa` ↔ `intentional-cognition-os-ziz`. GitHub: this-repo#140 ↔ ICO#99. Plane: INTKB-6 ↔ ICOS-23.

When making INTKB-side architectural decisions, the thesis paper is load-bearing: it names the 7 thesis properties + 7 design principles INTKB commits to, the spool-boundary discipline that defines the ICO → INTKB hand-off, and the why-not-just-git / why-not-just-prompt-memory arguments. New design work should not contradict the thesis without an explicit ADR.

The original thesis described the spool bridge as deferred. That is historical: the bridge subsequently shipped, as the dated note below records. Reverse-direction feedback has its own scope and must be checked separately.

**Note (2026-05-24):** the spool wire shipped via Build Item A — `qmd-team-intent-kb-oaa.3` (reader + cross-repo contract test) + `intentional-cognition-os-ziz.3` (writer). Only the reverse-direction feedback loop (`vj6`) remains deferred. The thesis §6.2 prose is one day stale on this point.

## Historical cross-repo proof-of-work tracking (2026-05)

Twin cross-repo epic with ICO. The end-to-end proof-of-work demo drives a real corpus through ICO compile → INTKB curator → qmd index → MCP retrieval → audit verify. Tracked as:

- INTKB epic: `qmd-team-intent-kb-66t` ↔ ICO twin `intentional-cognition-os-73m`
- GH: `jeremylongshore/bobs-big-brain-registrar#149` ↔ ICO `#114`
- INTKB children: `9jx` (curator CLI for the demo), `gvt` (promote `kmr` audit-log hash-chain verifier to load-bearing), `6yg` (smoke test — blocked on 9jx + gvt)

Parallel hygiene epic on INTKB only: `qmd-team-intent-kb-2x0` / GH `#150` — wire every `tests/JOURNEYS.md` step to its proving test via JSDoc annotations + rebuild via `journey-mapper-agent`. Closes the 42-of-43 unlinked journey-step gap.

The Compiler now contains `scripts/demo-e2e.sh` and a nightly smoke workflow. The historical IDs above preserve the original plan; they are not a current open-work inventory or a new demo execution receipt.
