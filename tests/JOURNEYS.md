# User Journeys — qmd-team-intent-kb

<!-- Managed by journey-mapper-agent. Engineer-declared journeys preserved across rebuilds. -->
<!-- Schema: ~/.claude/skills/audit-tests/references/rtm-personas-journeys.md §3 -->

End-to-end flows the system supports, with step-by-step mapping to the tests that prove each step. Coverage below threshold fires `journey-mapper-agent` warnings on the next `/audit-tests` run.

Default coverage threshold: 85% of steps across all journeys have a linked test. Critical journeys (`critical: true` in the header) require 100%. Gap severity mirrors the MoSCoW of linked RTM requirements.

---

## Journey: memory-capture

**Personas:** `developer` → `curator`
**Critical:** yes
**Trigger:** Claude Code session produces an insight worth retaining as durable team memory.
**Linked RTM:** REQ-001 (deterministic governance), REQ-003 (explicit lifecycle), REQ-004 (tenant isolation), REQ-005 (auditability)

| #   | Step                                                                          | Layer  | Test file                                                                                                                        | Status                                    |
| --- | ----------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | Claude Code session generates a memory candidate (proposal)                   | n/a    | external — Claude Code internals                                                                                                 | (out of scope)                            |
| 2   | ICOS compiles candidate to L2 / L4 artifact and writes to spool               | L4     | `apps/curator/src/__tests__/spool-intake-ico-contract.test.ts` (cross-repo round-trip) + ICO `packages/kernel/src/spool.test.ts` | ✓ wired (oaa.3 + ziz.3 closed 2026-05-24) |
| 3   | Curator's `ingestFromSpool` reads spool file, validates schema                | L3     | `apps/curator/src/intake/spool-intake.ts` + tests                                                                                | ⚠ needs step-to-test linking              |
| 4   | Policy-engine evaluates candidate (secret detection, dedup, tenant isolation) | L3     | `packages/policy-engine/src/__tests__/**`                                                                                        | ⚠ needs step-to-test linking              |
| 5   | Candidate written to inbox with policy evaluation results attached            | L3, L4 | `apps/api/src/routes/candidates.ts`, `apps/curator/src/__tests__/**`                                                             | ⚠ needs step-to-test linking              |
| 6   | Curator reviews inbox via `GET /api/candidates`                               | L4     | `apps/api/src/routes/candidates.ts` + tests                                                                                      | ⚠ needs step-to-test linking              |
| 7   | Curator promotes — `apps/curator/src/promotion/promoter.ts` runs              | L3     | `apps/curator/src/__tests__/promoter*.test.ts`                                                                                   | ⚠ needs step-to-test linking              |
| 8   | Curated memory persisted with `Active` lifecycle state                        | L3     | `packages/store/src/__tests__/memory-repository.test.ts`                                                                         | ⚠ needs step-to-test linking              |
| 9   | qmd index updated via edge-daemon sync                                        | L4, L5 | `apps/edge-daemon/src/__tests__/cycle*.test.ts`                                                                                  | ⚠ needs step-to-test linking              |
| 10  | Git exporter mirrors curated memory to git on next export run                 | L4     | `apps/git-exporter/src/__tests__/**`                                                                                             | ⚠ needs step-to-test linking              |

**Coverage:** 1/10 fully linked (step 2 — the ICOS → INTKB spool boundary). Step 1 is external (out of scope). Architecture exists for steps 3-10; cross-repo contract test exercises the spool intake end-to-end (cross-repo contract bead pair oaa.3 + ziz.3, both closed 2026-05-24).

---

## Journey: memory-retrieval

**Personas:** `developer`, `bot-agent`
**Critical:** yes
**Trigger:** developer (or Claude on their behalf) asks for team knowledge on a topic.
**Linked RTM:** REQ-002 (curated-only default search), REQ-007 (inbox/archive don't pollute default)

| #   | Step                                                                                   | Layer  | Test file                                                                       | Status                       |
| --- | -------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- | ---------------------------- |
| 1   | Client calls `teamkb_neighbors` MCP tool OR `GET /api/memories/search?q=...`           | L4     | `apps/mcp-server/src/__tests__/**`, `apps/api/src/__tests__/**`                 | ⚠ needs step-to-test linking |
| 2   | API-key auth + rate-limit middleware runs                                              | L3, L4 | `apps/api/src/middleware/api-key-auth.ts` + tests                               | ⚠ needs step-to-test linking |
| 3   | Search service scopes to caller's tenant                                               | L3     | `apps/api/src/services/search-service.ts` + tests                               | ⚠ needs step-to-test linking |
| 4   | qmd-adapter constructs query, scoped to curated collections by default                 | L3     | `packages/qmd-adapter/src/search/search-client.ts` + tests                      | ⚠ needs step-to-test linking |
| 5   | qmd CLI runs query against local index, returns ranked results                         | L4, L5 | `packages/qmd-adapter/src/executor/real-executor.ts` (integration)              | ⚠ needs step-to-test linking |
| 6   | Result parser maps qmd output back to MemoryRef objects                                | L3     | `packages/qmd-adapter/src/search/result-parser.ts` + tests                      | ⚠ needs step-to-test linking |
| 7   | Optional: wiki-link resolution rewrites `[[slug]]` to API URLs (`?resolve_links=true`) | L3     | `apps/curator/src/import/wikilink-parser.ts`, `apps/api/src/routes/memories.ts` | ⚠ needs step-to-test linking |
| 8   | Response returned to caller; audit log entry written                                   | L4     | `apps/api/src/services/memory-service.ts`, audit middleware                     | ⚠ needs step-to-test linking |

**Coverage:** 0/8 fully linked. Architecture exists for every step.

---

## Journey: vault-import

**Personas:** `operator`
**Critical:** no
**Trigger:** operator wants to seed the team KB with content from an existing Obsidian / Markdown vault.
**Linked RTM:** REQ-102 (vault import with rollback)

| #   | Step                                                                                                                          | Layer    | Test file                                                      | Status                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- | ---------------------------- |
| 1   | Operator runs `teamkb_vault_preview` MCP tool with vault path                                                                 | L4       | `apps/mcp-server/src/tools/vault-import.ts` + tests            | ⚠ needs step-to-test linking |
| 2   | Curator walks vault dir (`walkVault`), excluding `.obsidian/`, `.trash/`, `.git/`                                             | L3       | `apps/curator/src/import/**` + tests                           | ⚠ needs step-to-test linking |
| 3   | YAML frontmatter parsed (title, category, tags); content hashed                                                               | L3       | `apps/curator/src/import/parser*.test.ts`                      | ⚠ needs step-to-test linking |
| 4   | Content-hash collision check against curated + candidates + intra-batch                                                       | L3       | `apps/curator/src/dedup/dedup-checker.ts` + tests              | ⚠ needs step-to-test linking |
| 5   | Preview returns dry-run report (counts: files / created / rejected / skipped)                                                 | L4       | `apps/curator/src/import/**` + tests                           | ⚠ needs step-to-test linking |
| 6   | Operator reviews preview, decides whether to proceed                                                                          | (manual) | n/a                                                            | (out of scope)               |
| 7   | Operator runs `teamkb_vault_import` — `ImportBatch` row created with status `active`                                          | L3, L4   | `packages/store/src/__tests__/import-batch-repository.test.ts` | ⚠ needs step-to-test linking |
| 8   | Candidates inserted via `CandidateRepository.insert()` with `importBatchId`                                                   | L3       | `packages/store/src/__tests__/candidate-repository.test.ts`    | ⚠ needs step-to-test linking |
| 9   | Batch lifecycle moves to `completed`; counts updated                                                                          | L3       | `packages/store/src/__tests__/import-batch-repository.test.ts` | ⚠ needs step-to-test linking |
| 10  | If operator detects a problem, runs `teamkb_vault_rollback` — batch → `rolled_back`, candidates deleted via `deleteByBatch()` | L3, L4   | `apps/curator/src/__tests__/vault-rollback*.test.ts`           | ⚠ needs step-to-test linking |

**Coverage:** 0/10 fully linked. Step 6 is manual (out of scope). Architecture exists for the other 9.

---

## Journey: policy-update

**Personas:** `org-admin`
**Critical:** yes
**Trigger:** admin wants to add, modify, or remove a policy rule (secret-detection regex, tenant-isolation rule, dedup threshold).
**Linked RTM:** REQ-001 (deterministic governance — policy edits must not require LLM judgment), REQ-004 (tenant isolation)

| #   | Step                                                                                            | Layer | Test file                                                                  | Status                       |
| --- | ----------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------- | ---------------------------- |
| 1   | Admin calls `POST /api/policies` with new rule                                                  | L4    | `apps/api/src/routes/policies.ts` + tests                                  | ⚠ needs step-to-test linking |
| 2   | Policy-engine validates rule structure (Zod schema in `packages/schema`)                        | L3    | `packages/schema/src/__tests__/**`                                         | ⚠ needs step-to-test linking |
| 3   | Pre-activation checks: no duplicate IDs, no shadowing of stricter rules, no broad auto-approves | L3    | `packages/policy-engine/src/__tests__/**`                                  | ⚠ needs step-to-test linking |
| 4   | Rule written to `PolicyRepository`                                                              | L3    | `packages/store/src/__tests__/policy-repository.test.ts`                   | ⚠ needs step-to-test linking |
| 5   | Audit log entry recorded (admin, timestamp, rule diff)                                          | L4    | `apps/api/src/services/policy-service.ts` + tests                          | ⚠ needs step-to-test linking |
| 6   | Next memory candidate evaluated under the updated policy set                                    | L3    | `packages/policy-engine/src/__tests__/**`, `apps/curator/src/__tests__/**` | ⚠ needs step-to-test linking |
| 7   | (Optional: hot-reload deferred — see CLAUDE.md; restart required for now per REQ-901 WON'T)     | n/a   | n/a                                                                        | excluded                     |

**Coverage:** 0/6 fully linked (step 7 is excluded — out of scope per REQ-901 WON'T).

---

## Journey: audit-verification

**Personas:** `auditor`
**Critical:** no
**Trigger:** auditor needs to verify the system's integrity claims for compliance or incident response.
**Linked RTM:** REQ-005 (auditability), REQ-006 (control-plane is canonical)

| #   | Step                                                                                          | Layer  | Test file                                                      | Status                       |
| --- | --------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------- | ---------------------------- |
| 1   | Auditor calls `GET /api/audit?memoryId=X` (or with `tenantId`)                                | L4     | `apps/api/src/routes/audit.ts` + tests                         | ⚠ needs step-to-test linking |
| 2   | Audit-log read scoped to caller's tenant unless cross-tenant grant present                    | L3, L4 | `apps/api/src/middleware/api-key-auth.ts`, audit-route handler | ⚠ needs step-to-test linking |
| 3   | Full history returned: create / update / promote / demote / supersede / archive / search hits | L4     | `apps/api/src/__tests__/audit*.test.ts`                        | ⚠ needs step-to-test linking |
| 4   | Auditor verifies hash chain — each entry's hash matches the previous entry's hash             | L3     | (none — primitive not built)                                   | ✗ **gap**                    |
| 5   | If hash chain breaks, auditor identifies the tampered entry                                   | L3     | (none — primitive not built)                                   | ✗ **gap**                    |

**Coverage:** 0/5 fully linked. **Two real gaps** (steps 4-5): the audit log is structurally append-only but the hash-chain verification primitive is not implemented in this repo. CCSC has the analogous `bun server.ts --verify-audit-log <path>` primitive — this repo would benefit from an equivalent. File as a follow-up bd.

---

## Journey: wiki-link-resolution

**Personas:** `curator` → `developer`
**Critical:** no
**Trigger:** writer creates a memory containing `[[slug]]` or `[[slug|display]]` references to other memories.
**Linked RTM:** REQ-103 (wiki-link resolution + graph edge auto-creation)

| #   | Step                                                                                           | Layer | Test file                                                | Status                       |
| --- | ---------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------- | ---------------------------- |
| 1   | Curator promotes memory with `[[slug]]` content; parser extracts links                         | L3    | `apps/curator/src/import/wikilink-parser.ts` + tests     | ⚠ needs step-to-test linking |
| 2   | For each extracted link, promoter persists a `relates_to` edge to `memory_links`               | L3    | `apps/curator/src/promotion/promoter.ts` + tests         | ⚠ needs step-to-test linking |
| 3   | Reader retrieves memory with `?resolve_links=true`                                             | L4    | `apps/api/src/routes/memories.ts` + tests                | ⚠ needs step-to-test linking |
| 4   | `LinkResolver` callback looks up each `[[slug]]` against `MemoryRepository.searchByText(slug)` | L3    | `packages/store/src/__tests__/memory-repository.test.ts` | ⚠ needs step-to-test linking |
| 5   | Resolved content returned to caller with `[[slug]]` rewritten to `{id, title}` markup          | L4    | `apps/api/src/routes/memories.ts` + tests                | ⚠ needs step-to-test linking |
| 6   | If git-exporter is running, exported markdown wraps wiki-links via `LinkResolver` callback     | L4    | `apps/git-exporter/src/__tests__/**`                     | ⚠ needs step-to-test linking |

**Coverage:** 0/6 fully linked. Architecture exists end-to-end.

---

## Summary

| Journey              | Critical | Steps | In scope | Linked | Status                              |
| -------------------- | -------- | ----- | -------- | ------ | ----------------------------------- |
| memory-capture       | yes      | 10    | 9        | 1      | ⚠ linking pass — step 2 wired       |
| memory-retrieval     | yes      | 8     | 8        | 0      | ⚠ linking pass needed               |
| vault-import         | no       | 10    | 9        | 0      | ⚠ linking pass needed               |
| policy-update        | yes      | 7     | 6        | 0      | ⚠ linking pass needed               |
| audit-verification   | no       | 5     | 5        | 0      | ⚠ 2 real gaps (hash-chain verifier) |
| wiki-link-resolution | no       | 6     | 6        | 0      | ⚠ linking pass needed               |

**Total in-scope steps:** 43 across 6 journeys.
**Linked:** 1 (memory-capture step 2 — cross-repo spool boundary; bd chain `oaa.3` + ICO `ziz.3` closed 2026-05-24).
**Real coverage gaps:** 2 (audit-verification steps 4–5 — INTKB-side hash-chain verifier primitive not yet built; ICO ships its own equivalent `ico audit verify` in bead `intentional-cognition-os-ziz.4`).
**Blocked by other work:** 0 (Epic 16 work superseded by Build Item A; bd `qmd-team-intent-kb-6wk` and `pw9` closed 2026-05-24, `vj6` remains open as the opposite-direction feedback loop, out of scope for current pass).

## Next pass

1. **Step-to-test linking** — same infrastructure as PERSONAS coverage: decide on annotation convention (JSDoc on `describe` blocks recommended), then `journey-mapper-agent` walks tests and populates the Linked column.
2. **File a bd for the hash-chain verifier gap** — CCSC's `--verify-audit-log` is the reference. This repo should ship the analogous primitive (probably a CLI script in `apps/api` or `packages/store`).
3. ~~**Wait on Epic 16** — memory-capture step 2 (ICOS→qmd spool) is blocked by `qmd-team-intent-kb-6wk` → `pw9` → `vj6`. That chain is the wire from ICOS into this repo. Comes after the testing-SOP work is done.~~ **Done as of 2026-05-24.** The ICO→INTKB spool boundary shipped as Build Item A: ICO bead `intentional-cognition-os-ziz.3` (writer side) + this repo's `oaa.3` (reader side + cross-repo contract test). Step 2 is now wired; the only remaining Epic 16 piece is `vj6` (INTKB → ICO feedback loop), which is intentionally deferred as a separate direction of flow.

---

_Generated: 2026-05-14 · Updated by: journey-mapper-agent (manual seed) · Engineer overrides preserved on rebuild._
