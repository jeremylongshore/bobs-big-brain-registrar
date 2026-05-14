# Personas — qmd-team-intent-kb

<!-- Managed by persona-coverage-agent. Engineer-edited declarations preserved across rebuilds. -->
<!-- Schema: ~/.claude/skills/audit-tests/references/rtm-personas-journeys.md §2 -->

This file declares the distinct user roles the system serves, the key flows each role performs, and the test coverage of those flows. Coverage below threshold fires `persona-coverage-agent` warnings on the next `/audit-tests` run.

## How to read this file

- **Tier**: internal / paid / free / partner / etc. — used by policy and routing.
- **Permissions**: what the persona is authorized to do.
- **Key flows**: the role's representative end-to-end paths. Each flow must have ≥1 test (default threshold 80%).
- **Critical**: tagged personas have stricter rules — every key flow must have ≥1 test (100% threshold). Critical-tagged personas with uncovered MUST-flows fire P0 audit failures.

Default coverage threshold: 80% of declared flows have ≥1 linked test. Critical personas: 100%. See `tests/TESTING.md` §"Thresholds" to override.

---

## developer

**Role:** end-user of Claude Code in a team context. Runs `claude` sessions, generates memory candidates implicitly during work, queries curated team knowledge via MCP tools.

**Tier:** team-member
**Critical:** yes (primary value-delivery persona)
**Permissions:** read curated memories scoped to tenant; submit memory candidates; query via MCP tools (`teamkb_*`)

**Key flows:**

- `capture-insight` — Claude Code session produces an insight; ICOS compiles it; spool delivers a `MemoryCandidate` to the qmd-team-intent-kb curator inbox.
- `query-curated` — Developer (or Claude on their behalf) calls `teamkb_neighbors` / search endpoints; gets curated-only results by default.
- `query-with-inbox-opt-in` — Developer explicitly opts into seeing inbox content; gets unvetted candidates flagged as such.
- `consume-resolved-wiki-links` — Developer reads a memory whose `[[slug]]` references have been auto-resolved to API URLs.

**Test coverage:**

- `capture-insight`: deferred to Epic 16 (ICOS→qmd bridge) — `qmd-team-intent-kb-01x` ⚠ flow exists in design only
- `query-curated`: `apps/api/src/__tests__/**`, `packages/qmd-adapter/src/search/**` ⚠ needs test-to-persona linking
- `query-with-inbox-opt-in`: `packages/qmd-adapter/src/collections/**` ⚠ needs test-to-persona linking
- `consume-resolved-wiki-links`: `apps/curator/src/__tests__/wiki-link*.test.ts`, `apps/api/src/routes/memories.ts` (`?resolve_links=true`) ⚠ needs test-to-persona linking

**Coverage:** 0/4 fully linked (architecture exists, persona link annotation deferred to next pass). One flow (`capture-insight`) is blocked on Epic 16 — tracked, not a coverage gap to fix in this audit.

---

## curator

**Role:** human reviewer who decides what becomes durable team memory. Reads the inbox, promotes high-quality candidates, rejects noise, marks supersession chains.

**Tier:** team-lead
**Critical:** yes (governance correctness persona — this role's actions become durable team state)
**Permissions:** read inbox + curated; promote candidates; reject candidates; mark supersession; never delete (only archive)

**Key flows:**

- `review-inbox` — Curator lists pending memory candidates with policy-engine evaluation results attached.
- `promote-candidate` — Curator promotes a candidate; promoter persists `supersedes` graph edges with Jaccard similarity weight (when MemoryLinksRepository is provided).
- `reject-candidate` — Curator rejects with a reason; rejection logged, candidate moved to rejected pool.
- `mark-supersession` — Curator explicitly links a new memory as superseding an older one; both lifecycle states transition; readers of the old one auto-redirect.
- `archive-deprecated` — Curator archives a deprecated memory; excluded from default search going forward.

**Test coverage:**

- `review-inbox`: `apps/api/src/routes/candidates.ts`, `apps/curator/src/__tests__/**` ⚠ needs test-to-persona linking
- `promote-candidate`: `apps/curator/src/promotion/promoter.ts` + tests ⚠ needs test-to-persona linking
- `reject-candidate`: `apps/curator/src/rejection/rejector.ts` + tests ⚠ needs test-to-persona linking
- `mark-supersession`: `apps/curator/src/supersession/supersession-detector.ts` + tests ⚠ needs test-to-persona linking
- `archive-deprecated`: `packages/schema/src/__tests__/**` (lifecycle state machine) ⚠ needs test-to-persona linking

**Coverage:** 0/5 fully linked (architecture exists end-to-end; persona link annotation deferred to next pass).

---

## org-admin

**Role:** organization administrator. Manages tenants, sets policy rules, configures qmd collections, controls cross-tenant boundaries.

**Tier:** org-internal
**Critical:** yes (policy correctness persona — admin actions affect every tenant in the org)
**Permissions:** read/write policy; create/delete tenants; manage org-wide settings; read all audit logs

**Key flows:**

- `set-policy` — Admin writes a new policy rule via `apps/api` `/api/policies`; policy-engine evaluates it before activation (no shadowing of stricter rules, no broad auto-approves, no duplicate IDs).
- `create-tenant` — Admin creates a new tenant; isolation enforced at capture, policy, storage, search, export.
- `manage-collections` — Admin configures which qmd collections are part of the default search scope.
- `read-cross-tenant-audit` — Admin reads audit log across tenants (the only role permitted to do this).

**Test coverage:**

- `set-policy`: `packages/policy-engine/src/__tests__/**`, `apps/api/src/routes/policies.ts` + tests ⚠ needs test-to-persona linking
- `create-tenant`: `packages/policy-engine/src/__tests__/**` (tenant isolation), `apps/api/src/middleware/**` ⚠ needs test-to-persona linking
- `manage-collections`: `packages/qmd-adapter/src/collections/collection-manager.ts` + tests ⚠ needs test-to-persona linking
- `read-cross-tenant-audit`: `apps/api/src/routes/audit.ts` + tests ⚠ needs test-to-persona linking

**Coverage:** 0/4 fully linked.

---

## auditor

**Role:** compliance / security auditor. Verifies the system's integrity claims — tamper-evident audit log, deterministic policy decisions, tenant isolation enforcement.

**Tier:** compliance-internal
**Critical:** no (read-only role; misuse doesn't corrupt state)
**Permissions:** read audit logs only (scoped per tenant unless explicitly granted cross-tenant); read curated memories; cannot mutate

**Key flows:**

- `query-audit-log` — Auditor calls `GET /api/audit?memoryId=X` for a specific memory's full history.
- `verify-hash-chain` — Auditor verifies the audit log's hash chain end-to-end (every entry hashes the previous; tampering detected).
- `prove-tenant-isolation` — Auditor confirms that a cross-tenant query from tenant A cannot reach tenant B's memories.

**Test coverage:**

- `query-audit-log`: `apps/api/src/routes/audit.ts` + tests ⚠ needs test-to-persona linking
- `verify-hash-chain`: deferred — hash-chain audit verification primitive not yet built in this repo. Tracked as a gap.
- `prove-tenant-isolation`: `packages/policy-engine/src/__tests__/**` (tenant-isolation tests) ⚠ needs test-to-persona linking

**Coverage:** 0/3 fully linked. One flow (`verify-hash-chain`) is a real coverage gap — file as a follow-up bd if the audit-log primitive is intended to be self-verifying.

---

## operator

**Role:** devops / SRE who runs the deployment. Imports vaults, manages the edge-daemon, monitors health, handles incidents.

**Tier:** ops-internal
**Critical:** no (recoverable role — operator mistakes are reversible via rollback batches and explicit lifecycle transitions)
**Permissions:** run import operations; read edge-daemon health; trigger rebuilds; read all logs

**Key flows:**

- `vault-preview` — Operator runs `teamkb_vault_preview` MCP tool against an Obsidian / Markdown vault; gets a dry-run report (files found, collisions detected, would-be candidates).
- `vault-import` — Operator runs `teamkb_vault_import`; batch created, candidates inserted, batch lifecycle moved to `active`.
- `vault-rollback` — Operator runs `teamkb_vault_rollback`; batch lifecycle moves to `rolled_back`, candidates deleted via `CandidateRepository.deleteByBatch()`.
- `monitor-edge-daemon` — Operator checks edge-daemon health endpoint; sees sync status, last fetch, lag.

**Test coverage:**

- `vault-preview`: `apps/curator/src/__tests__/vault-import*.test.ts`, `apps/mcp-server/src/tools/vault-import.ts` ⚠ needs test-to-persona linking
- `vault-import`: `apps/curator/src/__tests__/vault-import*.test.ts` ⚠ needs test-to-persona linking
- `vault-rollback`: `apps/curator/src/__tests__/vault-import*.test.ts` (rollback path) ⚠ needs test-to-persona linking
- `monitor-edge-daemon`: `apps/edge-daemon/src/__tests__/**` ⚠ needs test-to-persona linking

**Coverage:** 0/4 fully linked.

---

## bot-agent

**Role:** programmatic consumer (Claude Code, Cursor, Codex, future MCP clients, Notion External Agent API). Calls MCP tools or the REST API with an API key.

**Tier:** machine
**Critical:** no (must operate within the same permission boundary as its calling user; abuse caught by rate limiter + policy engine)
**Permissions:** scoped to the user/tenant context of the API key; same read/write rules as the binding user persona

**Key flows:**

- `mcp-tool-call` — Agent invokes `teamkb_*` MCP tool over stdio; gets JSON response.
- `api-call` — Agent calls `apps/api` REST endpoint with API key; subject to `apps/api/src/middleware/api-key-auth.ts` + rate-limiter.
- `discover-capabilities` — Agent reads OpenAPI spec at `/openapi.json` to learn the API surface; or reads MCP tool list at protocol init.

**Test coverage:**

- `mcp-tool-call`: `apps/mcp-server/src/__tests__/**` ⚠ needs test-to-persona linking
- `api-call`: `apps/api/src/__tests__/**`, `apps/api/src/middleware/api-key-auth.ts` + tests ⚠ needs test-to-persona linking
- `discover-capabilities`: `apps/api/src/__tests__/openapi*.test.ts`, MCP protocol init handler ⚠ needs test-to-persona linking

**Coverage:** 0/3 fully linked.

---

## Summary

| Persona   | Critical | Flows | Linked | Coverage % | Status                                       |
| --------- | -------- | ----- | ------ | ---------- | -------------------------------------------- |
| developer | yes      | 4     | 0      | 0%         | ⚠ linking pass needed                        |
| curator   | yes      | 5     | 0      | 0%         | ⚠ linking pass needed                        |
| org-admin | yes      | 4     | 0      | 0%         | ⚠ linking pass needed                        |
| auditor   | no       | 3     | 0      | 0%         | ⚠ linking + 1 real gap (`verify-hash-chain`) |
| operator  | no       | 4     | 0      | 0%         | ⚠ linking pass needed                        |
| bot-agent | no       | 3     | 0      | 0%         | ⚠ linking pass needed                        |

**Total declared flows:** 23 across 6 personas. Architecture exists for 22 of them; one real coverage gap (auditor / `verify-hash-chain`).

**Linking pass not done in this PR.** Like RTM.md, this file is a first-pass scaffold. The persona-coverage-agent's next full run will walk every test file looking for `@persona developer @flow query-curated`-style annotations (or sidecar JSON), populate the Linked column, and compute real coverage percentages. Until that linking infrastructure lands, this file declares the _intent_ — what the system serves and what flows matter — without yet computing coverage.

## Next pass

1. **Add persona+flow annotation conventions** — decide whether to use vitest test-name tags (`it('promotes [persona:curator flow:promote-candidate]', ...)`), JSDoc tags (`@persona curator @flow promote-candidate`), or sidecar `tests/_annotations.json`. Recommended: JSDoc on `describe` blocks for low-friction adoption.
2. **persona-coverage-agent linking pass** — walk every test file, populate the `Test coverage` lines with real test names, compute coverage.
3. **File a bd for the `verify-hash-chain` gap** — the auditor persona's most important flow is currently unimplemented at the test layer; needs a primitive in the audit-log subsystem.

---

_Generated: 2026-05-14 · Updated by: persona-coverage-agent (manual seed) · Engineer overrides preserved on rebuild._
