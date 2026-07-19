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

This repo follows the Intent Solutions Testing SOP (see `~/000-projects/CLAUDE.md` § "Intent Solutions Testing SOP"):

- **Harness package:** `@intentsolutions/audit-harness` (pending install per issues #90–#103)
- **Audit skill:** `/audit-tests` — run for repo-level diagnostics
- **Install skill:** `/implement-tests` — run to install missing layers

### Current audit state (2026-04-21 baseline)

Grade C (~65/100). 119 test files exist but no enforcement:

- P0 gaps: `tests/TESTING.md` missing · no coverage thresholds · no pre-commit hooks · no `tests/RTM.md`
- P1 gaps: no Stryker mutation · no dep-cruiser · no gitleaks · no Semgrep · no testcontainers · no PERSONAS/JOURNEYS
- Full tracking: GitHub issues #90–#103 (see meta issue #103 for roadmap)
- Beads: 12 issues under `qmd-team-intent-kb-*`

### Once audit-harness is installed

Replace `~/.claude/` references in hooks/CI with in-repo commands:

```bash
pnpm exec audit-harness verify
pnpm exec audit-harness escape-scan --staged
pnpm exec audit-harness init          # only after engineer-reviewed policy edits
```

See `.husky/pre-commit` + `.github/workflows/ci.yml` for wiring patterns.

## Build Commands

```
pnpm install          # Install all dependencies
pnpm validate         # Run format:check + lint + typecheck + test (gate for all PRs)
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
cd apps/api && pnpm dev    # tsx watch src/index.ts
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
       │    └→ policy-engine (8 deterministic rule evaluators)
       │         └→ api (Fastify REST) + curator (promotion pipeline)
       ├→ store (SQLite via better-sqlite3, 5 repositories)
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
- **AuditEvent** — Immutable trail of all memory operations
- **SearchQuery/SearchResult** — Typed search with scope control

Key enums: `MemoryLifecycleState` (active/deprecated/superseded/archived), `Sensitivity` (public/internal/confidential/restricted), `MemoryCategory`, `TrustLevel`, `CandidateStatus`, `SearchScope`

**Lifecycle state machine** (`packages/schema/src/lifecycle.ts`):

```
active → [deprecated, superseded, archived]
deprecated → [active, archived]
superseded → [archived]
archived → [] (terminal)
```

### Store (packages/store)

SQLite via better-sqlite3 with 5 tables: `candidates`, `curated_memories`, `governance_policies`, `audit_events`, `export_state`. Each has a repository class. Use `createTestDatabase()` for in-memory test databases.

### Policy Engine (packages/policy-engine)

`PolicyPipeline` composes rules and short-circuits on first failure. Rules are registered in `RULE_REGISTRY` keyed by `PolicyRuleType` enum. Current rules: secret-detection, content-length, source-trust, relevance-score, dedup-check, tenant-match, sensitivity-gate, content-sanitization.

### API (apps/api)

Fastify 5 with dependency injection via `buildApp(deps: AppDependencies)`. Middleware stack: rate-limiter → api-key-auth → input-sanitizer. Routes: `/api/candidates`, `/api/memories`, `/api/policies`, `/api/audit`, `/api/search`, `/health`.

#### Cited-query report (brain adoption KPI)

`POST /api/search` emits one structured `query-access` access-log line per read (`{ actor, query, scope, resultCount, citations }`) — deliberately a log line, _not_ a governance `AuditEvent`, so the hash-chained trail stays pure for `ico audit verify`. `apps/api/src/reports/` aggregates those lines into the **weekly cited-query count per teammate** (a _cited_ query = one that returned ≥1 `qmd://` citation):

```bash
pnpm build                              # produce apps/api/dist
pnpm report:cited-queries               # last 7 days, human table
pnpm report:cited-queries --days 30 --json   # JSON for the notification hub
```

The aggregator (`cited-queries.ts`) is pure and source-agnostic; the CLI (`weekly-cited-queries-cli.ts`) is the only piece that reads the systemd **user** journal (`teamkb-brain-api.service`, persistent journald = the durable access log). `--stdin` pipes lines from any source instead. Intended to run weekly via cron or the notification hub.

### Curator (apps/curator)

Orchestrates the full promotion pipeline: spool intake → policy evaluation → dedup check (content hash) → supersession detection (Jaccard title similarity) → promote or reject. Supports dry-run mode.

### Git Exporter (apps/git-exporter)

Incremental export of curated memories to `kb-export/` as Markdown with YAML frontmatter. Category-based directory routing (decisions/, curated/, guides/, archive/). Tracks last export timestamp via `ExportStateRepository`.

## Monorepo Layout

- `apps/api/` — Control plane REST API (Fastify)
- `apps/curator/` — Memory promotion, dedupe, supersession engine
- `apps/edge-daemon/` — Local qmd sync daemon (cycle, lock, health, CLI subcommands)
- `apps/git-exporter/` — Git mirror/export service
- `apps/reporting/` — Analytics and lifecycle reporting
- `packages/schema/` — Zod domain model, lifecycle state machine
- `packages/store/` — SQLite persistence layer (better-sqlite3)
- `packages/qmd-adapter/` — qmd CLI wrapper, search, index management
- `packages/claude-runtime/` — Session capture, secret scanning, spool
- `packages/policy-engine/` — Deterministic governance rule pipeline
- `packages/repo-resolver/` — Multi-repo context resolver (resolveRepoContext, tenant derivation, monorepo detection, cache)
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
- All PRs must pass `pnpm validate` before merge
- Test database helper: `createTestDatabase()` from `packages/store` for in-memory SQLite
- Temp directories via `mkdtempSync` for spool/file system tests

## CI/CD

- **ci.yml** — Format → Lint → Typecheck → Test (on push to main/develop, PRs to main)
- **gemini-review.yml** — AI code review via GCP Workload Identity Federation
- **release.yml** — Dispatch or tag-triggered, validates CHANGELOG and placeholder detection
- **security.yml** — Weekly npm audit, lockfile integrity, secret scanning
- **nightly.yml** — Full validation, dependency audit, outdated packages

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
- Always `bd sync` after closing
- Workflow: `bd update <id> --status in_progress` → work → `bd close <id> --reason "evidence"` → `bd sync`

### Scaffolding vs Implemented

- Be explicit about what is currently scaffolding vs implemented
- Placeholder packages contain only package.json, tsconfig.json, and src/index.ts with a TODO comment
- Do not claim features work when they are only scaffolded
- Update `000-docs/004-PP-RMAP-phase-plan.md` when implementation status changes

### Release & Changelog

- Semantic Versioning, CHANGELOG.md in Keep a Changelog format
- Every user-facing change needs a changelog entry (Added, Changed, Fixed, Security, Deprecated, Removed)
- Use `/release` skill for release preparation

### Enterprise Mode Standards

- All code must pass lint, format, and type checks
- All PRs require review (human + Gemini automated review)
- Security considerations documented for every new subsystem
- Dependency updates reviewed, not auto-merged

## Ecosystem positioning — INTKB is the governance layer of ICO + INTKB

INTKB is the **governance layer** of a two-layer ecosystem with `intentional-cognition-os` (ICO) as the upstream compilation layer:

```
ICO (compile) → spool → INTKB (govern, dedupe, score) → qmd (retrieve) → MCP/REST
```

The canonical reference for this positioning is the peer-reviewed thesis paper:

- `000-docs/034-AT-NTRP-ecosystem-thesis.md` — **"Compile, Then Govern: A Two-Layer Local-First Architecture for Team Institutional Memory"** (2026-05-23). Byte-identical copy lives in `intentional-cognition-os/000-docs/034-AT-NTRP-ecosystem-thesis.md`. Cross-repo epic: bead `qmd-team-intent-kb-oaa` ↔ `intentional-cognition-os-ziz`. GitHub: this-repo#140 ↔ ICO#99. Plane: INTKB-6 ↔ ICOS-23.

When making INTKB-side architectural decisions, the thesis paper is load-bearing: it names the 7 thesis properties + 7 design principles INTKB commits to, the spool-boundary discipline that defines the ICO → INTKB hand-off, and the why-not-just-git / why-not-just-prompt-memory arguments. New design work should not contradict the thesis without an explicit ADR.

The ICO → INTKB spool bridge itself is currently deferred (`qmd-team-intent-kb-pw9` → `vj6`, Epic 16). The thesis is honest about this gap.

**Note (2026-05-24):** the spool wire shipped via Build Item A — `qmd-team-intent-kb-oaa.3` (reader + cross-repo contract test) + `intentional-cognition-os-ziz.3` (writer). Only the reverse-direction feedback loop (`vj6`) remains deferred. The thesis §6.2 prose is one day stale on this point.

## Current cross-repo build — proof-of-work demo (next milestone)

Twin cross-repo epic with ICO. The end-to-end proof-of-work demo drives a real corpus through ICO compile → INTKB curator → qmd index → MCP retrieval → audit verify. Tracked as:

- INTKB epic: `qmd-team-intent-kb-66t` ↔ ICO twin `intentional-cognition-os-73m`
- GH: `jeremylongshore/bobs-big-brain-registrar#149` ↔ ICO `#114`
- INTKB children: `9jx` (curator CLI for the demo), `gvt` (promote `kmr` audit-log hash-chain verifier to load-bearing), `6yg` (smoke test — blocked on 9jx + gvt)

Parallel hygiene epic on INTKB only: `qmd-team-intent-kb-2x0` / GH `#150` — wire every `tests/JOURNEYS.md` step to its proving test via JSDoc annotations + rebuild via `journey-mapper-agent`. Closes the 42-of-43 unlinked journey-step gap.

When `66t` ships, the demo doubles as the nightly CI smoke that prevents regression of any link in the ICO → INTKB → qmd chain.
