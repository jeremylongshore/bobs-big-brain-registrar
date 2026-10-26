# Repository Blueprint

> **Implementation note — 2026-10-26:** This is the original blueprint, not the current inventory or license statement. The project is now Bob’s Big Brain Registrar; root `package.json` requires Node.js 22+ and declares Apache-2.0, matching `LICENSE`. There are six app and ten library workspaces. See [README](../README.md) and [the source reconciliation](063-AA-AUDR-registrar-source-contract-reconciliation-2026-10-26.md) for current source boundaries; the original plan below is retained.

## Repository Identity

- **Name**: qmd-team-intent-kb
- **Owner**: Jeremy Longshore (personal project)
- **License**: Intent Solutions Proprietary
- **Purpose**: Governed team memory platform for Claude Code powered by qmd

## Purpose

qmd-team-intent-kb provides a governed, shared knowledge layer for teams using Claude Code. It captures institutional knowledge generated during Claude Code sessions, applies deterministic governance policies, curates and deduplicates that knowledge, and makes it searchable via qmd's local full-text indexing. The goal is to turn ephemeral session insights into persistent, governed, team-wide memory.

## Monorepo Structure

```
qmd-team-intent-kb/
├── apps/                  # Deployable applications
│   ├── api/               # Control plane REST API (Fastify)
│   ├── curator/           # Memory promotion, dedupe, supersession
│   ├── edge-daemon/       # Local qmd sync daemon
│   ├── git-exporter/      # Git mirror/export
│   └── reporting/         # Analytics and lifecycle
├── packages/              # Shared libraries
│   ├── schema/            # Shared Zod schemas and domain types
│   ├── qmd-adapter/       # qmd CLI/API integration layer
│   ├── claude-runtime/    # Claude Code session capture
│   ├── policy-engine/     # Memory governance policy evaluation
│   ├── repo-resolver/     # Multi-repo context resolution
│   └── common/            # Shared utilities
├── kb-export/             # Git-exported curated knowledge output
├── 000-docs/              # Project documentation
├── .github/               # CI/CD workflows and templates
├── tasks/                 # Beads task tracking
└── tests/                 # Integration tests (repo root)
```

## Tech Stack

| Layer         | Technology                 |
| ------------- | -------------------------- |
| Language      | TypeScript 5.x             |
| Runtime       | Node.js 20+                |
| Package mgmt  | pnpm workspaces (monorepo) |
| Test runner   | Vitest                     |
| Linting       | ESLint 9 (flat config)     |
| Formatting    | Prettier                   |
| API framework | Fastify (apps/api)         |
| Schemas       | Zod                        |
| Search/index  | qmd (local full-text)      |

## Package Manifest

### Applications (`apps/`)

| Package             | Description                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`          | Control plane REST API built on Fastify. Provides memory CRUD, search delegation, governance administration, and authentication endpoints. The central authority for canonical memory state.                           |
| `apps/curator`      | Memory promotion engine. Validates candidates against policy, deduplicates using similarity scoring, detects supersession relationships, and assigns lifecycle states. Moves memory from inbox to curated status.      |
| `apps/edge-daemon`  | Local sync daemon that replicates canonical store contents to local qmd indexes. Handles incremental sync, change detection, and conflict resolution for offline/distributed usage.                                    |
| `apps/git-exporter` | Publishes curated knowledge to configurable git repositories in structured Markdown + frontmatter format. Performs incremental export of only changed memories. Git is a distribution mirror, not the source of truth. |
| `apps/reporting`    | Analytics and lifecycle reporting. Tracks memory health, search usage, governance audit trails, and team knowledge dashboards.                                                                                         |

### Libraries (`packages/`)

| Package                   | Description                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schema`         | Shared Zod schemas and derived TypeScript types for the entire domain model: MemoryCandidate, CuratedMemory, MemoryLifecycle, GovernancePolicy, SearchQuery, SearchResult, and more. The single source of truth for data shapes.                              |
| `packages/qmd-adapter`    | Integration layer wrapping the qmd CLI and API for programmatic access. Manages index creation, updates, deletion, and search queries. Enforces curated-only default search semantics.                                                                        |
| `packages/claude-runtime` | Captures memory proposals from Claude Code sessions. Hooks into session events, extracts memory candidates, applies pre-policy secret filtering, and spools raw candidates to the inbox.                                                                      |
| `packages/policy-engine`  | Evaluates memory candidates against configurable governance rules. Implements secret detection, deduplication scoring, relevance evaluation, tenant isolation enforcement, and rule composition pipelines. All decisions are deterministic — no LLM judgment. |
| `packages/repo-resolver`  | Resolves multi-repo context for memory scoping. Determines which project/team a memory belongs to and enforces tenant boundaries during capture and search.                                                                                                   |
| `packages/common`         | Shared utilities used across apps and packages: logging, error handling, configuration loading, date/time helpers, and other cross-cutting concerns.                                                                                                          |

## Standards

- **Commits**: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, etc.)
- **Changelog**: Keep a Changelog format
- **Versioning**: Semantic Versioning (SemVer)
- **Task tracking**: Beads (`bd`) for epic/task lifecycle with post-compaction recovery
- **Code quality**: ESLint 9 flat config + Prettier + TypeScript strict mode
- **Testing**: Vitest with workspace-aware configuration

## CI/CD

- **Platform**: GitHub Actions
- **Triggers**: push to `main`/`develop`, PRs targeting `main`
- **Pipeline**: install → lint → format:check → typecheck → test
- **Code review**: Automated Gemini code review via `google-github-actions/run-gemini-cli` with Workload Identity Federation (WIF) authentication
- **Quality gate**: All PRs must pass `pnpm validate` (format:check + lint + typecheck + test)
- **Dependency management**: GitHub Dependabot enabled

## Current Status

**Phase 0 — Foundation (COMPLETE)**

Scaffolding only. The monorepo structure, CI pipeline, documentation, security policies, and contribution guidelines are in place. No production runtime features exist yet. All application and library packages contain directory scaffolding but no implemented functionality.
