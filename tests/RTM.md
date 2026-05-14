# Requirements Traceability Matrix — qmd-team-intent-kb

<!-- Managed by rtm-builder-agent. Engineer-edited MoSCoW overrides preserved across rebuilds. -->
<!-- Schema: ~/.claude/skills/audit-tests/references/rtm-personas-journeys.md -->

This file traces requirements to the tests that prove them. Every `MUST` row without a test is a P0 audit failure; every test that doesn't reference a `REQ-*` ID is an orphaned test (P1 advisory).

## How to read this file

| Column          | Meaning                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Req ID**      | Stable identifier — `REQ-NNN`. Never reused.                                                                             |
| **MoSCoW**      | `MUST` blocks audit if uncovered. `SHOULD` is P1 advisory. `COULD` is P2 logged. `WON'T` is excluded from coverage math. |
| **Source**      | The doc/feature file/ADR that introduced the requirement. Provenance.                                                    |
| **Description** | One-line statement of what the system must do.                                                                           |
| **Layers**      | 7-layer taxonomy positions this requirement must be tested at.                                                           |
| **Test Files**  | Paths to the tests that prove this requirement. `(none)` = uncovered.                                                    |
| **Status**      | ✓ Covered · ✗ P0 BLOCK · ⚠ P1 advisory · P2 logged · Excluded                                                            |

MoSCoW assignment precedence: explicit source tag → source-document default → engineer override (preserved across rebuilds) → `SHOULD` fallback. See the canonical spec for details.

---

## Architecture invariants (from `000-docs/003-AT-DSGN-system-thesis.md`)

These seven design principles are the load-bearing contracts of the system. All `MUST`.

| Req ID  | MoSCoW | Source                                                                              | Description                                                                                                                                                   | Layers | Test Files                                                                 | Status                         |
| ------- | ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------- | ------------------------------ |
| REQ-001 | MUST   | `003-AT-DSGN-system-thesis.md` §"Determinism Over LLM Judgment"                     | All governance decisions (promotion, demotion, dedup, secret detection, tenant isolation) made by deterministic code only — no LLM judgment in critical paths | L3, L4 | `packages/policy-engine/src/__tests__/**`                                  | ⚠ Needs test-to-REQ link audit |
| REQ-002 | MUST   | `003-AT-DSGN-system-thesis.md` §"Curated-Only Default Search"                       | Default search returns only curated content; inbox + archived content excluded unless explicit opt-in                                                         | L3, L4 | `packages/qmd-adapter/src/search/**`, `apps/api/src/routes/**`             | ⚠ Needs test-to-REQ link audit |
| REQ-003 | MUST   | `003-AT-DSGN-system-thesis.md` §"Explicit Lifecycle"                                | Every curated memory has an explicit lifecycle state (Active / Deprecated / Superseded / Archived) with logged transitions (timestamp, actor, reason)         | L3, L4 | `packages/schema/src/__tests__/**`, `apps/curator/src/__tests__/**`        | ⚠ Needs test-to-REQ link audit |
| REQ-004 | MUST   | `003-AT-DSGN-system-thesis.md` §"Tenant Isolation by Default"                       | Memories scoped to project + team at capture; cross-tenant contamination prevented at capture, policy, storage, search, export                                | L3, L4 | `packages/policy-engine/src/__tests__/**`, `apps/api/src/middleware/**`    | ⚠ Needs test-to-REQ link audit |
| REQ-005 | MUST   | `003-AT-DSGN-system-thesis.md` §"Auditability of All Memory Operations"             | Every memory operation produces an audit-log entry (create / update / promote / demote / supersede / archive / search)                                        | L3, L4 | `apps/api/src/__tests__/**`, `apps/curator/src/__tests__/**`               | ⚠ Needs test-to-REQ link audit |
| REQ-006 | MUST   | `003-AT-DSGN-system-thesis.md` §"qmd is the Edge, not the Truth"                    | Control-plane API is canonical; qmd is downstream edge index; git is downstream mirror — neither is source of truth                                           | L4, L5 | `apps/api/src/__tests__/**`, `apps/edge-daemon/src/__tests__/**`           | ⚠ Needs test-to-REQ link audit |
| REQ-007 | MUST   | `003-AT-DSGN-system-thesis.md` §"Inbox and Archive Must Not Pollute Default Search" | Raw candidates (inbox) and retired memories (archive) excluded from default retrieval; explicit query required                                                | L3, L4 | `packages/qmd-adapter/src/collections/**`, `apps/api/src/routes/search.ts` | ⚠ Needs test-to-REQ link audit |

## Capabilities shipped through v0.5.0 (from `CHANGELOG.md`)

`SHOULD` by default — feature behavior; product still works if any one item degrades, but operator-visible quality matters.

| Req ID  | MoSCoW | Source                                         | Description                                                                                                      | Layers | Test Files                                                           | Status                         |
| ------- | ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------- | ------------------------------ |
| REQ-100 | SHOULD | `CHANGELOG.md` §[0.5.0] "Knowledge Graph"      | `memory_links` table supports 5 link types (relates_to, supersedes, contradicts, depends_on, part_of)            | L3     | `packages/store/src/__tests__/memory-links*.test.ts`                 | ⚠ Needs test-to-REQ link audit |
| REQ-101 | SHOULD | `CHANGELOG.md` §[0.5.0] "Knowledge Graph"      | Recursive CTE graph traversal with configurable depth (max 5)                                                    | L3, L4 | `packages/store/src/__tests__/**`, `apps/api/src/routes/memories.ts` | ⚠ Needs test-to-REQ link audit |
| REQ-102 | SHOULD | `CHANGELOG.md` §[0.5.0] "Vault Import"         | Markdown vault import with YAML frontmatter parsing + content-hash collision detection + batch rollback          | L3, L4 | `apps/curator/src/__tests__/vault-import*.test.ts`                   | ⚠ Needs test-to-REQ link audit |
| REQ-103 | SHOULD | `CHANGELOG.md` §[0.5.0] "Wiki-Link Resolution" | `[[slug]]` and `[[slug\|display]]` parsing with code-block awareness; write-path auto-creates `relates_to` edges | L3     | `packages/store/src/__tests__/wiki-link*.test.ts`                    | ⚠ Needs test-to-REQ link audit |
| REQ-104 | SHOULD | `CHANGELOG.md` §[0.5.0] "MCP Tools"            | `teamkb_vault_preview`, `teamkb_vault_import`, `teamkb_vault_rollback`, `teamkb_neighbors` MCP tools exposed     | L3, L5 | `apps/mcp-server/src/__tests__/**`                                   | ⚠ Needs test-to-REQ link audit |
| REQ-105 | SHOULD | `CHANGELOG.md` §[0.4.0] "OpenAPI"              | OpenAPI 3.1 spec served at `/openapi.json`; Swagger UI at `/docs`                                                | L4, L5 | `apps/api/src/__tests__/openapi*.test.ts`                            | ⚠ Needs test-to-REQ link audit |

## Operational requirements

| Req ID  | MoSCoW | Source                               | Description                                                                            | Layers | Test Files                              | Status                         |
| ------- | ------ | ------------------------------------ | -------------------------------------------------------------------------------------- | ------ | --------------------------------------- | ------------------------------ |
| REQ-200 | MUST   | `028-OD-SECU-release-signing.md`     | Edge-daemon container image signed via cosign keyless; SLSA provenance attached        | L5     | `.github/workflows/release-*.yml` smoke | ⚠ Needs test-to-REQ link audit |
| REQ-201 | SHOULD | `006-TQ-SECU-security-governance.md` | Secrets scanning runs on every PR (gitleaks); SAST runs on every PR (Semgrep, planned) | L2     | `.github/workflows/security.yml`        | ⚠ Needs test-to-REQ link audit |
| REQ-202 | SHOULD | `005-TQ-TEST-testing-ci-strategy.md` | Coverage floor enforced at 80% line / 70% branch / 75% function in CI                  | L3     | `vitest.config.ts` thresholds           | ⚠ Needs test-to-REQ link audit |

## WON'T (explicitly out of scope this iteration)

| Req ID  | MoSCoW | Source                   | Description                                                                   | Status   |
| ------- | ------ | ------------------------ | ----------------------------------------------------------------------------- | -------- |
| REQ-900 | WON'T  | engineer call 2026-04-24 | Per-user policy rules (organization-level only for v1)                        | Excluded |
| REQ-901 | WON'T  | engineer call 2026-04-24 | Hot-reload of policy rules (restart-on-policy-change documented in CLAUDE.md) | Excluded |

## Orphaned tests

Tests that do not reference any `REQ-*` ID in a docstring, vitest tag, or sidecar. Currently advisory (P1) — orphans may be useful regression tests the engineer wants to keep, but they indicate untracked intent.

_(Populated by `rtm-builder-agent` on its first full pass — this file is a seed scaffold.)_

## Next pass

This RTM is a **first-pass scaffold** that captures the load-bearing architectural commitments (REQ-001 through REQ-007 from the system thesis) and the v0.5.0 shipped capabilities (REQ-100 through REQ-105). It needs:

1. **Full source-doc extraction** by `rtm-builder-agent` — walking every `000-docs/*.md` ADR-style file and every CHANGELOG entry to produce additional `REQ-*` rows.
2. **Test-to-REQ linking** in each test file's leading docstring (`@requires REQ-001 REQ-004` or similar). Until that link exists, the "Status" column says "needs test-to-REQ link audit" rather than ✓ Covered, because we can't prove the link from the test alone.
3. **Coverage gates wired to RTM**: every `MUST` row without a test file path triggers a P0 audit failure.

Tracked as the second pass after this Batch 1 PR lands.

---

_Generated: 2026-05-14 · Updated by: rtm-builder-agent (manual seed) · Engineer overrides preserved on rebuild._
