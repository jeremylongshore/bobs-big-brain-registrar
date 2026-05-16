# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-05-15

### Security

- **Cleared 6 high-severity dev-tooling CVEs.** `pnpm.overrides` block pins `picomatch@2: ^2.3.2` (closes ReDoS via micromatch/fast-glob/knip path), `picomatch@4: ^4.0.4` (closes ReDoS in newer path via vite/fdir), `fast-uri: ^3.1.2` (closes path traversal + host confusion via ajv/Stryker). Direct `vite: ^7.3.2` devDep added to pull patched vite for vitest peer (closes `server.fs.deny` bypass + arbitrary file read via dev server). `pnpm audit --audit-level=high` is now clean.

### Added

- **Intent Solutions Testing SOP — Batch 1** (PR #126): `tests/TESTING.md` policy file, `tests/RTM.md` requirements traceability matrix seed, husky + lint-staged pre-commit hooks, vitest coverage thresholds (line 80, branch 70, function 75), Stryker mutation testing config, Semgrep SAST job, CLAUDE.md Testing SOP section. Closes GH #90/#91/#92/#93/#94/#97.
- **Intent Solutions Testing SOP — Batch 2**: dependency-cruiser monorepo architecture rules (`.dependency-cruiser.cjs`) enforced in CI via `pnpm depcruise`. Encodes 6 invariants from `000-docs/003-AT-DSGN-system-thesis.md` as machine-verifiable import-graph rules: packages must not depend on apps; no cross-app imports except apps/curator (which publishes a workspace package); no circular deps; test-fixtures may only be imported by tests; no dist/ imports; all imports must resolve. Closes GH #95.
- **Real gitleaks secret scanning** via `gitleaks-action@v2` on every PR — replaces the prior homegrown `git grep` regex scanner that only fired on PRs touching `package.json`/`pnpm-lock.yaml`. Closes GH #96.
- **Intent Solutions Testing SOP — Batch 3**: `tests/PERSONAS.md` declares the 6 distinct user roles the system serves (developer, curator, org-admin, auditor, operator, bot-agent) with 23 key flows and critical-tier marking. `tests/JOURNEYS.md` declares 6 end-to-end user flows (memory-capture, memory-retrieval, vault-import, policy-update, audit-verification, wiki-link-resolution) with 43 step-by-step mappings. `tests/TESTING.md` §Traceability updated to reflect new artifacts. Test-to-persona / step-to-test linking infrastructure deferred to a follow-up pass (annotation convention TBD). Closes GH #99.
- **Intent Solutions Testing SOP — Batch 4**: `scripts/crap-score.ts` — TypeScript-AST-aware cyclomatic complexity scanner (ports CCSC's reference implementation, adapted for the monorepo to walk `packages/*/src` + `apps/*/src`). Wired to CI as a new `Complexity gate (CRAP / Wall 5)` step. Initial threshold 40 with 4 points of headroom over the current ceiling (`apps/edge-daemon` `runCycle` at 36) — tightening to the Wall 5 ideal of 30 tracked in `qmd-team-intent-kb-igs` (refactor `runCycle` first). Added `tsx` as a root devDep to run the script. Closes GH #100.
- **Intent Solutions Testing SOP — Batch 5**: testcontainers infrastructure for L4 integration tests. After a survey of every L4 surface (per `tests/TESTING.md` §"L4 — partial waiver"), no current code path requires a real-service container — but the audit explicitly tracked the gap and Batch 5 establishes the pattern. Adds `testcontainers` + `@testcontainers/postgresql` + `pg` devDeps. Ships one demonstrative test (`tests/integration/postgres-forward-compat.test.ts`): spins up `postgres:16-alpine`, applies the store DDL (with documented SQLite→postgres translation), round-trips a candidate row, verifies PRIMARY KEY uniqueness, sanity-checks the tenant index — surfaces dialect-specific SQL early. Separate `integration` CI job that fires on push to main and on PRs labeled `integration` — does NOT slow the fast `validate` loop. Three documented trigger conditions for expanding L4 coverage are tracked in `qmd-team-intent-kb-2r6` (P3). Closes GH #98.
- **Intent Solutions Testing SOP — Batch 6**: contract testing via OpenAPI snapshot, replacing the generic Pact recommendation that doesn't fit this monorepo's shape (no internal service-to-service HTTP boundary; no external consumer code yet). Ships `apps/api/src/__tests__/openapi-contract.test.ts` — boots `apps/api` in-process, fetches `GET /openapi.json`, snapshot-tests the structural surface (paths × methods, schema names, security schemes, tag names). Any unintentional API surface change fails CI until a contributor explicitly runs `pnpm vitest --update-snapshots` and the diff becomes a code-review signal. Forward trigger to install actual Pact (`@pact-foundation/pact`) tracked in `qmd-team-intent-kb-4zw` (P3) — fires when an external consumer repo is created and deployed independently from `apps/api` with a different release cadence. Closes GH #101.
- **Intent Solutions Testing SOP — Batch 7 (closing pin)**: `scripts/harness-pin.sh` + committed `.harness-hash`. SHA-256 manifest of every engineer-owned policy artifact in the repo (`tests/TESTING.md`, `tests/RTM.md`, `tests/PERSONAS.md`, `tests/JOURNEYS.md`, `.dependency-cruiser.cjs`, `stryker.config.mjs`, `vitest.config.ts`, `scripts/crap-score.ts`). New CI step `Policy-artifact hash pin (harness-pin --verify)` fails on any unrecognized policy-byte change. AI agents can update observational sections freely but cannot silently change policy without engineer-initiated re-pin (`pnpm harness-pin:init`). Repo-local script encodes the right pin set; upstream pattern-configurability tracked in `qmd-team-intent-kb-tpp` (P3). Closes GH #102. **All 14 audit-tests issues from the 2026-04-24 audit are now closed.**

### Changed

- **`.github/workflows/security.yml`** broadened: gitleaks runs on every PR (secrets can land in any file). `audit` + `lockfile-integrity` jobs continue to gate dep-touching PRs only (their narrow scope is intentional).
- **`.github/workflows/ci.yml`**: new `Architecture rules (dependency-cruiser)` step between `Type check` and `Test`.

### Fixed

- **`apps/api/tsconfig.json` + `apps/mcp-server/tsconfig.json`**: added the missing `{ "path": "../curator" }` project reference. Both apps import from `@qmd-team-intent-kb/curator` (an `apps/curator`-exported workspace package) but lacked the project reference, so clean CI builds failed with `TS2307: Cannot find module '@qmd-team-intent-kb/curator'`. Local builds masked the issue via composite-build cache. This had been the root cause of CI redness on main since the 2026-04-16 v0.5.0 wiki-link PR introduced the imports.
- **`package.json` `pnpm.onlyBuiltDependencies`**: added `better-sqlite3`, `esbuild`, `husky` so that pnpm 9's build-script security model allows the native bindings to compile on clean install. Without this, 451 of 1,312 tests fail with "Could not locate the bindings file" on every fresh clone.

## [0.5.0] - 2026-04-16

### Added

- **Knowledge Graph**: `memory_links` table with 5 link types (relates_to, supersedes, contradicts, depends_on, part_of), bidirectional neighbor queries, and recursive CTE graph traversal up to configurable depth.
- **Import Batches**: `import_batches` table for batch lifecycle tracking (active → completed | rolled_back) with file/created/rejected/skipped counts.
- **Vault Import Pipeline**: Recursive Markdown directory walker with `.obsidian/`, `.trash/`, `.git/` exclusion; YAML frontmatter parser (title, category, tags); content hash collision detection against curated memories, candidates, and intra-batch duplicates; batch-tracked candidate creation; rollback capability.
- **Import API Routes**: `POST /api/import/preview` (dry-run), `POST /api/import` (execute), `GET /api/import/batches` (list), `GET /api/import/batches/:id` (detail), `DELETE /api/import/batches/:id` (rollback).
- **Graph Traversal API**: `GET /api/memories/:id/neighbors` (bidirectional links), `GET /api/memories/:id/graph?depth=N` (recursive traversal, max depth 5).
- **Wiki-Link Resolution**: Parser for `[[slug]]` and `[[slug|display]]` syntax with code-block awareness. Write-path: auto-creates `relates_to` graph edges during promotion. Read-path: `?resolve_links=true` query param on memory GET rewrites links to API URLs.
- **MCP Tools**: `teamkb_vault_preview`, `teamkb_vault_import`, `teamkb_vault_rollback` for Obsidian vault import; `teamkb_neighbors` for graph exploration.
- **Schema Enums**: `LinkType`, `LinkSource`, `ImportBatchStatus` for graph and import domain model.
- **Repositories**: `MemoryLinksRepository` (CRUD + neighbors + traverse), `ImportBatchRepository` (CRUD + updateCounts + complete + rollback).
- **Curator Supersession Edges**: Promoter persists `supersedes` graph edges with Jaccard similarity weight when `MemoryLinksRepository` is provided.
- **Git Exporter**: `formatMemoryAsMarkdown` accepts optional `LinkResolver` callback for wiki-link resolution on export.
- Import conversion recipes documentation (`000-docs/030-DR-GUID-import-conversion-recipes.md`) covering Obsidian, Notion, Google Docs, Confluence, and pandoc workflows.

### Changed

- **Zod 4 Migration**: `packages/schema` and `packages/repo-resolver` migrated from zod@3 to zod@4. Fixed `z.record(z.unknown())` → `z.record(z.string(), z.unknown())` and nested `.default({})` explicit full defaults for Zod 4 compatibility.
- **MCP Server**: Removed inline enum workarounds — now imports `MemoryCategory` and `MemoryLifecycleState` directly from schema package.
- `CandidateRepository.insert()` accepts optional `importBatchId` for batch association.
- `CandidateRepository.deleteByBatch()` enables batch rollback.

### Fixed

- `MemoryLinksRepository.traverse()` uses `ROW_NUMBER` window function for deterministic results when multiple paths to the same node exist.

## [0.4.0] - 2026-04-15

### Added

- `apps/api`: generated OpenAPI 3.1 spec served at `GET /openapi.json` and Swagger UI at `GET /docs`, powered by `@fastify/swagger` + `@fastify/swagger-ui`. Routes declare minimal schema metadata (tags, summary, description) for navigable documentation. The spec and docs UI are exempt from API key authentication so they stay publicly reachable.
- npm publishing configuration for reusable library packages (`@qmd-team-intent-kb/schema`, `@qmd-team-intent-kb/common`, `@qmd-team-intent-kb/repo-resolver`) — `publishConfig.access = public`, `files` allowlist, and minimal package READMEs. Internal-only packages (`store`, `qmd-adapter`, `claude-runtime`, `test-fixtures`, `policy-engine`) remain `private: true`. Strategy documented in `000-docs/029-OD-RELS-npm-publishing-strategy.md`.
- `apps/edge-daemon`: configurable health-server bind host via `DAEMON_HEALTH_HOST` environment variable. Defaults to `127.0.0.1` for security; set to `0.0.0.0` for container deployments.
- `apps/edge-daemon`: repo-scope filtering now surfaces `unscoped` candidate count for operator visibility when candidates bypass scoping.

### Changed

- Consolidated shared test fixture factories (`makeCandidate`, `makeMemory`, `RecordingLogger`) into `@qmd-team-intent-kb/test-fixtures` package. All test files now import from the shared package.
- Removed unused code paths identified by knip sweep, including vestigial logger implementations and weak type casts.
- Schema tests refactored to use rest-destructure pattern instead of `as Record<string, unknown>` delete pattern.
- Store repositories now validate on read with Zod instead of type casts.
- Upgraded `actions/checkout` to v6, `pino` to v10.3.1, `prettier` to v3.8.3.

### Fixed

- `apps/edge-daemon`: health-server start now properly awaited during `stop()` to prevent resource leaks.
- `apps/edge-daemon`: systemd unit override now correctly configures spool and PID paths to `/var/lib/edge-daemon`.
- `apps/edge-daemon`: `pino-pretty` moved from `devDependencies` to `dependencies` for production logging.
- `000-docs`: runbook Health Check section now documents `/healthz` and `/last-cycle` endpoints.
- `.github/workflows`: Gemini review prompt and MCP server configuration restored after accidental removal.

### Security

- Release workflow now builds, pushes, and signs the edge-daemon container image on tag pushes. Images are published to `ghcr.io/jeremylongshore/qmd-team-intent-kb-edge-daemon`, signed keyless via `cosign` using GitHub Actions OIDC (Rekor transparency log), and accompanied by SLSA Level 3 build provenance generated by `slsa-github-generator`. Verification procedure documented in `000-docs/028-OD-SECU-release-signing.md`.

## [0.3.0] - 2026-03-19

### Added

- MCP server (`apps/mcp-server`) with 5 tools: `teamkb_propose`, `teamkb_import`, `teamkb_status`, `teamkb_transition`, `teamkb_sync`
- Claude Code plugin packaging: `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`
- SessionStart hook (`scripts/bootstrap.sh`) for database initialization and qmd collection setup
- Stop hook (`scripts/flush-spool.sh`) for end-of-session spool draining
- TeamKB skill definition (`skills/teamkb/SKILL.md`) for ambient capture guidance
- 4 subagent definitions: `teamkb-curator`, `teamkb-classifier`, `teamkb-conflict-checker`, `teamkb-scout`
- Rejection feedback channel (`apps/edge-daemon/src/feedback.ts`) for governance learning
- FTS5 virtual table for full-text search with ranked results
- Schema migrations framework (`packages/store`) with `schema_migrations` table
- Intra-batch deduplication in curator pipeline
- Path traversal validation in spool writer and git exporter
- Per-agent spool files for multi-agent concurrency

### Fixed

- Node 20 compatibility using fast-glob instead of node:fs/promises glob (requires Node 22)
- Timing-safe API key comparison with `crypto.timingSafeEqual`
- Fail-closed authentication in production mode
- LIKE wildcard escaping (`%`, `_`, `\`) in SQL text search
- Shutdown handler exits with non-zero code on failure

### Security

- File permissions 0700 on `~/.teamkb/` directory
- `busy_timeout = 5000` pragma for WAL mode concurrency
- `--` argument separator for qmd CLI commands

---

## [0.2.0] - 2026-03-19

### Added

- Search API endpoint (`POST /api/search`) with freshness-aware reranking combining raw scores with exponential time decay and category boost
- Edge daemon (`apps/edge-daemon`) with full implementation: local spool watch, curation cycle, staleness sweep, index sync, PID locking, graceful shutdown
- Staleness automation — auto-deprecate active memories older than configurable `staleDays` threshold with audit trail
- Freshness scoring utilities (`packages/common`) with exponential decay, category boost weights, and generic reranking function
- SQL text search on MemoryRepository with LIKE-based query, tenant/category filters, active-only scope
- Graduated relevance scoring in policy engine: content length tiers, unique word count signal, manual/import source bonus

### Changed

- Relevance score rule now uses graduated weights: title (+0.20), content 50-200 chars (+0.10), content >200 chars (+0.20), unique words >15 (+0.10), manual/import source (+0.10)
- Upgraded Vitest to v4.1, ESLint to v10, Zod to v4, @types/node to v25
- Added `vitest.config.ts` for explicit test file discovery

### Fixed

- TypeScript project references now properly configured across all packages

---

## [0.1.0] - 2026-03-19

### Added

- API middleware stack: rate-limiter (sliding window), API key authentication, input sanitizer with recursive traversal (Phase 8, 76 tests)
- Content classifier with sensitivity-gate and content-sanitization policy rules (Phase 8)
- Export gating — git-exporter respects sensitivity classification (Phase 8)
- Path-safety utilities in common package with traversal and null-byte detection (Phase 8)
- Reporting app with lifecycle analytics: memory aggregator, policy aggregator, lifecycle formatters (Phase 7, 53 tests)
- Git exporter with incremental Markdown export, YAML frontmatter, category-based directory mapping, and idempotent writes (Phase 6, 76 tests)
- Curator engine with full promotion pipeline: spool intake, exact-hash dedup, policy evaluation, Jaccard supersession detection, dry-run mode (Phase 5, 79 tests)
- Control plane REST API with Fastify: candidate intake, memory lifecycle transitions, policy CRUD, audit trail, health check (Phase 4C, 62 tests)
- SQLite persistence layer (`packages/store`) with better-sqlite3, WAL mode, 5 repositories, in-memory testing (Phase 4B, 38 tests)
- Policy engine with 6 deterministic rule evaluators and short-circuit pipeline: secret detection, content length, source trust, relevance score, dedup check, tenant match (Phase 4A, 54 tests)
- Release workflow with dispatch trigger, tag trigger, changelog validation, and placeholder detection
- Security workflow with weekly npm audit, lockfile integrity check, and secret scanning
- Nightly workflow with full validation, dependency audit, and outdated dependency check
- Test artifact upload in CI workflow for post-run analysis
- `build` script in root package.json (`tsc -b`)
- Issue template config linking blank issues to GitHub Discussions
- Branch protection checklist doc (016-OD-OPSM)
- qmd adapter with curated-only default search, 5 collection types, and index isolation per tenant
- Real qmd CLI integration with RealQmdExecutor and health check
- Claude runtime capture layer with local JSONL spool, secret detection (11 patterns), and content redaction
- Shared utilities: Result<T, E> type, SHA-256 content hashing, TeamKB path resolution
- Shell hook templates and CLAUDE.md guidance block generators
- Core domain model with Zod schemas for MemoryCandidate, CuratedMemory, GovernancePolicy, SearchQuery/Result, and AuditEvent
- Lifecycle state machine with transition validation (active, deprecated, superseded, archived)
- Shared primitive types (UUID, SHA-256 hash, ISO datetime, Author, ContentMetadata)
- 12 enum definitions covering memory source, trust level, category, and governance actions
- SearchScope defaults to curated-only, enforcing governed search behavior
- CuratedMemory refinement requiring supersession link when lifecycle is superseded
- 225 schema tests covering valid/invalid inputs, defaults, and edge cases
- Monorepo scaffolding with pnpm workspaces (apps/, packages/, kb-export/, tests/, scripts/, examples/)
- Architecture documentation and system thesis (000-docs/001-repo-blueprint)
- Security policy with project-specific threat model covering memory integrity, MCP risk, and tenant isolation
- Contribution guidelines with commit conventions, PR expectations, and review process
- CI pipeline with lint, format check, type check, and test validation via GitHub Actions
- Gemini code review via Workload Identity Federation on pull requests
- 12-document knowledge base in 000-docs/
- Release and versioning policy following Semantic Versioning
- Beads task tracking initialization with 10 epics spanning foundation through enterprise features
