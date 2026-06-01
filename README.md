# qmd-team-intent-kb

**A governed team memory platform for Claude Code powered by qmd.**

Turn ephemeral Claude Code session insights into persistent, governed, team-wide memory. qmd-team-intent-kb captures institutional knowledge generated during AI-assisted development, applies deterministic governance policies, and makes curated knowledge searchable through qmd's local full-text indexing.

> **Part of the [Compile-Then-Govern](https://github.com/intent-solutions-io/compile-then-govern) stack** — INTKB is the **govern** layer. Upstream, [intentional-cognition-os](https://github.com/jeremylongshore/intentional-cognition-os) (compile) emits the spool it consumes; downstream, [qmd](https://github.com/tobi/qmd) (retrieve) serves the curated result with `qmd://` citations. → [Ecosystem overview](https://github.com/intent-solutions-io/compile-then-govern)

## Positioning

This project has a clear separation of responsibilities:

- **qmd** is the local search and index engine. It does one thing well: fast, offline full-text retrieval.
- **qmd-team-intent-kb** provides everything around it: orchestration, governance, lifecycle management, deduplication, analytics, and the team-shared memory model.
- **Enterprise-capable from day one.** Tenant isolation, audit trails, and governance policies are architectural requirements, not afterthoughts.

## Architecture Thesis

The system is built on a strict information flow with deliberate trust boundaries:

1. **Claude Code proposes memory.** During sessions, Claude Code generates memory candidates — insights, patterns, decisions, and lessons. These are proposals, not facts.

2. **Deterministic code decides what becomes durable team memory.** A policy engine evaluates every candidate against configurable governance rules. Secret filtering, deduplication scoring, relevance evaluation, and tenant isolation are all enforced programmatically. No LLM judgment is involved in promotion decisions.

3. **qmd serves as the local retrieval and index edge engine.** Curated, approved memories are synced to local qmd indexes for fast, offline search. The edge daemon handles replication and conflict resolution.

4. **A canonical memory control plane owns truth, lifecycle, governance, deduplication, and analytics.** The control plane API is the single source of truth for memory state. It manages the full lifecycle: inbox, review, promotion, archival, and supersession.

5. **Git is a mirror, export, and distribution layer — not the canonical database.** The git exporter publishes curated knowledge to git repositories in structured Markdown + frontmatter format. Git enables distribution and versioning, but it is downstream of the control plane.

6. **Default search targets curated knowledge only.** When a developer or Claude Code session queries memory, the default search scope is curated, policy-approved knowledge. This is a deliberate design constraint.

7. **Inbox and archive content must not pollute default search.** Raw candidates in the inbox and retired memories in the archive are excluded from default retrieval. Accessing them requires explicit, intentional queries. This prevents unvetted or stale content from contaminating team knowledge.

## Monorepo Structure

```
qmd-team-intent-kb/
├── apps/                    # Deployable applications
│   ├── api/                 # Control plane REST API (Fastify)
│   ├── curator/             # Memory promotion, dedupe, supersession
│   ├── edge-daemon/         # Local qmd sync daemon
│   ├── git-exporter/        # Git mirror/export
│   └── reporting/           # Analytics and lifecycle dashboards
├── packages/                # Shared libraries
│   ├── schema/              # Shared Zod schemas and domain types
│   ├── qmd-adapter/         # qmd CLI/API integration layer
│   ├── claude-runtime/      # Claude Code session capture
│   ├── policy-engine/       # Memory governance policy evaluation
│   ├── repo-resolver/       # Multi-repo context resolution
│   └── common/              # Shared utilities
├── kb-export/               # Git-exported curated knowledge output
├── 000-docs/                # Project documentation and RFCs
├── examples/                # Usage examples and templates
├── scripts/                 # Build and maintenance scripts
├── tests/                   # Integration tests (repo root)
└── .github/                 # CI/CD workflows and templates
```

### Applications

| Package             | Purpose                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`          | Control plane REST API. Memory CRUD, search delegation, governance admin, authentication. The central authority for canonical memory state. |
| `apps/curator`      | Memory promotion engine. Validates candidates against policy, deduplicates, detects supersession, assigns lifecycle states.                 |
| `apps/edge-daemon`  | Local sync daemon with spool watch, curation cycle, staleness sweep, PID locking, and graceful shutdown. Replicates to local qmd indexes.   |
| `apps/git-exporter` | Publishes curated knowledge to git repos in structured Markdown + frontmatter. Incremental export only.                                     |
| `apps/reporting`    | Analytics, lifecycle reporting, governance audit trails, and team knowledge dashboards.                                                     |

### Libraries

| Package                   | Purpose                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schema`         | Shared Zod schemas and derived TypeScript types for the entire domain model. Single source of truth for data shapes.            |
| `packages/qmd-adapter`    | Integration layer wrapping qmd CLI/API. Manages indexes, enforces curated-only default search semantics.                        |
| `packages/claude-runtime` | Captures memory proposals from Claude Code sessions. Hooks into session events, applies pre-policy secret filtering.            |
| `packages/policy-engine`  | Evaluates candidates against governance rules. Secret detection, dedup scoring, relevance, tenant isolation. All deterministic. |
| `packages/store`          | SQLite persistence layer via better-sqlite3. WAL mode, 5 repository classes, in-memory test database helper.                    |
| `packages/repo-resolver`  | Multi-repo context resolution. Determines project/team ownership and enforces tenant boundaries.                                |
| `packages/common`         | Shared utilities: Result<T, E> type, SHA-256 content hashing, path-safety validation, freshness scoring with reranking.         |

## Status

**v0.6.0 — Production-ready platform with full Intent Solutions Testing SOP enforced in CI.**

All core subsystems functional. 1,313 unit tests + 4 testcontainers-based L4 integration tests passing. CI enforces 10 gates per PR: typecheck → lint → format → architecture (dep-cruiser) → complexity (CRAP) → unit tests → coverage 80% line / 70% branch → secrets (gitleaks) → npm audit (when deps change) → SAST (Semgrep advisory). Policy artifacts hash-pinned via `scripts/harness-pin.sh` so the testing-SOP is self-defending against silent AI policy edits.

Highlights:

- **Schema & Domain Model** — Zod schemas, lifecycle state machine, 12 enum types (Phase 1)
- **Claude Runtime Capture** — Session capture, local JSONL spool, 11-pattern secret detection (Phase 2)
- **qmd Adapter** — CLI wrapper, curated-only default search, tenant-isolated indexes (Phase 3)
- **Policy Engine** — 8 deterministic rule evaluators with short-circuit pipeline (Phase 4A)
- **SQLite Store** — 5 repositories, WAL mode, in-memory test support (Phase 4B)
- **Control Plane API** — Fastify 5, candidate intake, memory lifecycle, policy CRUD, audit trail (Phase 4C)
- **Curator Engine** — Spool intake, dedup, Jaccard supersession detection, dry-run mode (Phase 5)
- **Git Exporter** — Incremental Markdown export, YAML frontmatter, category routing (Phase 6)
- **Reporting** — Lifecycle analytics, aggregators, formatters (Phase 7)
- **Security Hardening** — API middleware (rate-limiter, auth, input sanitizer), content classifier, export gating, path-safety (Phase 8)
- **Repo Resolver** — Multi-repo context resolution with monorepo detection, tenant derivation, and caching (Phase 9)
- **OpenAPI Documentation** — Generated OpenAPI 3.1 spec at `/openapi.json` and Swagger UI at `/docs` (Phase 10)
- **Supply-Chain Security** — Cosign keyless signing + SLSA Level 3 provenance for container images (Phase 10)

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9.15+

### Setup

```bash
# Clone the repository
git clone https://github.com/jeremylongshore/qmd-team-intent-kb.git
cd qmd-team-intent-kb

# Install dependencies
pnpm install

# Run the full validation suite (format, lint, typecheck, test)
pnpm validate
```

### Available Scripts

| Script              | Description                                   |
| ------------------- | --------------------------------------------- |
| `pnpm validate`     | Run all checks: format, lint, typecheck, test |
| `pnpm lint`         | Run ESLint                                    |
| `pnpm format:check` | Check Prettier formatting                     |
| `pnpm typecheck`    | Run TypeScript compiler checks                |
| `pnpm test`         | Run Vitest test suite                         |
| `pnpm build`        | Build all packages (tsc -b composite build)   |
| `pnpm clean`        | Remove all build artifacts and node_modules   |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branching model, commit conventions, PR expectations, and development workflow.

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability reporting, threat model, and security practices.

## License

[MIT License](./LICENSE) -- Copyright 2026 Jeremy Longshore
