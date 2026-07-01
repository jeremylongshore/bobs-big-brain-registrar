# Risk Register

> Active risks for qmd-team-intent-kb, tracked from project inception. Updated at each phase completion and during After Action Reviews.

---

## Risk Matrix

| Likelihood \ Impact | Low | Medium | High       | Critical |
| ------------------- | --- | ------ | ---------- | -------- |
| **High**            |     | R6     | R7         | R1       |
| **Medium**          |     |        | R2, R5, R9 | R4       |
| **Low**             |     | R8     |            | R10      |

---

## Active Risks

### R1 — Secret Leakage into Memory Candidates

| Attribute        | Value                                                                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**           | R1                                                                                                                                                                                                                                                                                       |
| **Risk**         | Secrets (API keys, tokens, passwords, private keys) are captured as part of memory candidates and persisted in the knowledge base                                                                                                                                                        |
| **Likelihood**   | High                                                                                                                                                                                                                                                                                     |
| **Impact**       | Critical                                                                                                                                                                                                                                                                                 |
| **Mitigation**   | Secret detection filter in the capture pipeline (Phase 2). The `secret_detection` PolicyRule type will scan all candidate content against known secret patterns before any persistence occurs. Default GovernancePolicy will include this rule with `reject` action at highest priority. |
| **Status**       | Open — mitigated at design level, not yet implemented                                                                                                                                                                                                                                    |
| **Owner**        | Core team                                                                                                                                                                                                                                                                                |
| **Target Phase** | Phase 2 (Capture Pipeline)                                                                                                                                                                                                                                                               |
| **Notes**        | This is the highest-priority security risk. No memory candidate should be persisted without passing secret detection. The pattern library should cover AWS keys, GCP service account keys, GitHub tokens, generic high-entropy strings, and custom patterns configurable per tenant.     |

---

### R2 — qmd API/CLI Instability

| Attribute        | Value                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**           | R2                                                                                                                                                                                        |
| **Risk**         | qmd is an external dependency whose API and CLI interface may change without notice, breaking our integration                                                                             |
| **Likelihood**   | Medium                                                                                                                                                                                    |
| **Impact**       | High                                                                                                                                                                                      |
| **Mitigation**   | Adapter pattern isolates the qmd dependency behind `packages/qmd-adapter`. All qmd interactions go through this adapter, so changes to qmd's interface only require updating one package. |
| **Status**       | Open — adapter package scaffolded, implementation pending                                                                                                                                 |
| **Owner**        | Core team                                                                                                                                                                                 |
| **Target Phase** | Phase 3 (qmd Integration)                                                                                                                                                                 |
| **Notes**        | Monitor qmd releases and changelog. Pin to specific versions in package.json. Maintain integration tests that exercise the adapter against the real qmd CLI.                              |

---

### R3 — Schema Evolution Breaks Existing Data

| Attribute        | Value                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**           | R3                                                                                                                                                                                                                                                            |
| **Risk**         | Changes to Zod schemas (adding required fields, changing types, renaming fields) break existing persisted data that was valid under the previous schema                                                                                                       |
| **Likelihood**   | Medium                                                                                                                                                                                                                                                        |
| **Impact**       | High                                                                                                                                                                                                                                                          |
| **Mitigation**   | Zod schemas will include version numbers. Migration tooling will be developed alongside schema changes. All schema changes will follow the breaking change process defined in [008-release-and-versioning-policy.md](./008-release-and-versioning-policy.md). |
| **Status**       | Open — schemas not yet defined                                                                                                                                                                                                                                |
| **Owner**        | Core team                                                                                                                                                                                                                                                     |
| **Target Phase** | Phase 1 (Schema Definition)                                                                                                                                                                                                                                   |
| **Notes**        | Key design decision: should schemas be forward-compatible (new versions can read old data) or require explicit migration? Forward compatibility is strongly preferred — migrations should be reserved for major structural changes.                           |

---

### R4 — Cross-Project Memory Contamination

| Attribute        | Value                                                                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**           | R4                                                                                                                                                                                                                                                                                       |
| **Risk**         | Memories from one project or team leak into another project's search results, causing confusion or exposing sensitive information                                                                                                                                                        |
| **Likelihood**   | Medium                                                                                                                                                                                                                                                                                   |
| **Impact**       | Critical                                                                                                                                                                                                                                                                                 |
| **Mitigation**   | Tenant isolation at both storage and search layers. The `tenant` field on CuratedMemory is a mandatory isolation key. All search queries are tenant-scoped. The `tenant_match` PolicyRule enforces correct tenant assignment during governance. Cross-tenant queries are never implicit. |
| **Status**       | Open — architecture defined, implementation not started                                                                                                                                                                                                                                  |
| **Owner**        | Core team                                                                                                                                                                                                                                                                                |
| **Target Phase** | Phase 4 (Governance Pipeline)                                                                                                                                                                                                                                                            |
| **Notes**        | This risk is critical because the entire value proposition of team memory depends on trust. If teams cannot trust that their memories are isolated, they will not use the system. Defense in depth: enforce at capture, governance, storage, and search layers.                          |

---

### R5 — MCP Trust Boundary Violation

| Attribute        | Value                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**           | R5                                                                                                                                                                                                                                                                                                                                                             |
| **Risk**         | Memories ingested via MCP (Model Context Protocol) bypass trust controls or carry incorrect trust levels, allowing low-quality or malicious content into the knowledge base                                                                                                                                                                                    |
| **Likelihood**   | Medium                                                                                                                                                                                                                                                                                                                                                         |
| **Impact**       | High                                                                                                                                                                                                                                                                                                                                                           |
| **Mitigation**   | MCP source tagging differentiates MCP-sourced memories from other sources. The `mcpSource` field records which MCP server provided the memory. The `trustLevel` field is set based on source, with MCP sources defaulting to `low` unless the MCP server is in a trust registry. The `source_trust` PolicyRule can enforce minimum trust levels for promotion. |
| **Status**       | Open — design phase                                                                                                                                                                                                                                                                                                                                            |
| **Owner**        | Core team                                                                                                                                                                                                                                                                                                                                                      |
| **Target Phase** | Phase 5 (MCP Integration)                                                                                                                                                                                                                                                                                                                                      |
| **Notes**        | MCP is a powerful integration point but also a significant attack surface. An untrusted MCP server could inject misleading memories that then influence Claude Code sessions across the team. The trust registry approach (explicit opt-in for each MCP server) is more secure than trust-by-default.                                                          |

---

### R6 — Scope Creep from Feature Requests

| Attribute        | Value                                                                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**           | R6                                                                                                                                                                                                                                                                                                       |
| **Risk**         | Feature requests and good ideas expand the project scope beyond what can be delivered, leading to incomplete implementation across too many fronts                                                                                                                                                       |
| **Likelihood**   | High                                                                                                                                                                                                                                                                                                     |
| **Impact**       | Medium                                                                                                                                                                                                                                                                                                   |
| **Mitigation**   | Strict adherence to the phase plan ([004-phase-plan.md](./004-phase-plan.md)). New feature ideas go through the RFC process ([009-contribution-workflow.md](./009-contribution-workflow.md)). Features not in the current phase are deferred, not rejected — they go into the backlog for future phases. |
| **Status**       | Mitigated — phase plan and RFC process documented                                                                                                                                                                                                                                                        |
| **Owner**        | Core team                                                                                                                                                                                                                                                                                                |
| **Target Phase** | Ongoing                                                                                                                                                                                                                                                                                                  |
| **Notes**        | The phase plan is the primary defense against scope creep. Every "wouldn't it be nice if..." must be evaluated against the current phase priorities. If it is not in scope, it goes in the backlog. Discipline here is essential for a single-maintainer project.                                        |

---

### R7 — Single Maintainer Bus Factor

| Attribute        | Value                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**           | R7                                                                                                                                                                                                                                                                                                                                 |
| **Risk**         | The project has a single primary maintainer. If that person becomes unavailable, the project stalls with no one able to continue the work effectively                                                                                                                                                                              |
| **Likelihood**   | High                                                                                                                                                                                                                                                                                                                               |
| **Impact**       | High                                                                                                                                                                                                                                                                                                                               |
| **Mitigation**   | Documentation-first approach ensures all architecture decisions, patterns, and workflows are captured in durable documents. The 000-docs/ directory, CLAUDE.md, and CONTRIBUTING.md provide enough context for a new contributor to understand and continue the project. Beads task tracking provides work-in-progress visibility. |
| **Status**       | Partially mitigated — documentation is being built alongside the project                                                                                                                                                                                                                                                           |
| **Owner**        | Core team                                                                                                                                                                                                                                                                                                                          |
| **Target Phase** | Ongoing                                                                                                                                                                                                                                                                                                                            |
| **Notes**        | This risk cannot be fully mitigated without additional contributors. The documentation-first approach reduces the impact (someone could pick up the project) but does not reduce the likelihood (there is still one maintainer). Accepting this risk is appropriate for the current project stage.                                 |

---

### R8 — Performance at Scale (Large Knowledge Bases)

| Attribute        | Value                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**           | R8                                                                                                                                                                                                                                    |
| **Risk**         | Search performance degrades as the knowledge base grows to thousands or tens of thousands of memories                                                                                                                                 |
| **Likelihood**   | Low                                                                                                                                                                                                                                   |
| **Impact**       | Medium                                                                                                                                                                                                                                |
| **Mitigation**   | qmd handles the core search performance (vector/semantic search). The control plane (tenant filtering, governance filtering) adds minimal overhead. Performance optimization is deferred until there is real data to measure against. |
| **Status**       | Accepted — premature to optimize                                                                                                                                                                                                      |
| **Owner**        | Core team                                                                                                                                                                                                                             |
| **Target Phase** | Post-1.0 (if needed)                                                                                                                                                                                                                  |
| **Notes**        | This is a classic "cross that bridge when we come to it" risk. The architecture does not prevent future optimization (caching, indexing, pagination are all possible). Optimizing now without data would be speculative engineering.  |

---

### R9 — Claude Code API/Hook Changes

| Attribute        | Value                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**           | R9                                                                                                                                                                                                                              |
| **Risk**         | Claude Code changes its extension points, hooks, or API surface, breaking the memory capture and retrieval integration                                                                                                          |
| **Likelihood**   | Medium                                                                                                                                                                                                                          |
| **Impact**       | High                                                                                                                                                                                                                            |
| **Mitigation**   | Adapter pattern in the `claude-runtime` package isolates Claude Code-specific integration behind an interface. Changes to Claude Code's API require updating only this package.                                                 |
| **Status**       | Open — adapter package scaffolded, implementation pending                                                                                                                                                                       |
| **Owner**        | Core team                                                                                                                                                                                                                       |
| **Target Phase** | Phase 6 (Claude Code Integration)                                                                                                                                                                                               |
| **Notes**        | Claude Code is actively developed and its extension points may evolve. The adapter pattern is the standard mitigation for external dependency instability. Maintain integration tests that exercise the real Claude Code hooks. |

---

### R10 — Dependency Supply Chain Attack

| Attribute        | Value                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ID**           | R10                                                                                                                                                                                                                                                                |
| **Risk**         | A compromised npm dependency introduces malicious code into the project                                                                                                                                                                                            |
| **Likelihood**   | Low                                                                                                                                                                                                                                                                |
| **Impact**       | Critical                                                                                                                                                                                                                                                           |
| **Mitigation**   | Standard supply chain controls: Dependabot enabled for automated security updates, lockfile (`pnpm-lock.yaml`) committed and reviewed in PRs, minimal dependency footprint (prefer standard library over third-party when reasonable), regular `pnpm audit` in CI. |
| **Status**       | Mitigated — standard controls in place                                                                                                                                                                                                                             |
| **Owner**        | Core team                                                                                                                                                                                                                                                          |
| **Target Phase** | Ongoing                                                                                                                                                                                                                                                            |
| **Notes**        | This is an industry-wide risk, not specific to this project. The mitigations are standard best practices. The most important control is the minimal dependency philosophy — every dependency added increases the attack surface.                                   |

---

### R11 — Silent Search Degradation (0-hit index)

| Attribute        | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**           | R11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Risk**         | `brain_search` degrades to an EMPTY result rather than an error when the qmd index is missing, empty, stale, or tenant-misrouted, so a broken retrieval index is invisible at the tool surface — every query silently returns nothing while the brain appears healthy.                                                                                                                                                                                                                                                                      |
| **Likelihood**   | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Impact**       | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Mitigation**   | A **search-health canary** (`@qmd-team-intent-kb/qmd-adapter` — `runSearchCanary` / CLI `qmd-index canary`) runs known-positive control queries and **fails loudly (exit 1) if any returns 0 hits**. Wired into the nightly CI workflow (fixture-brain reindex + canary) and the live nightly compile pre-flight. An idempotent `reindex` (CLI `qmd-index reindex`, or `canary --heal`) rebuilds the Tier-C-derived index from `kb-export/` without touching source-of-truth. Runtime tenant pinned to `intent-solutions` (the live brain). |
| **Status**       | Mitigated — canary + reindex CLI shipped (bead `compile-then-govern-e06.13`, umbrella #27); live `local` + `intent-solutions` indexes verified healthy                                                                                                                                                                                                                                                                                                                                                                                      |
| **Owner**        | Core team                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Target Phase** | Ongoing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Notes**        | Root cause (2026-06-29): the corpus was indexed under tenant `intent-solutions` but a runtime path resolved `TEAMKB_TENANT_ID=local`/unset → empty `local` index → 0 hits on candidates AND known-positive controls. The qmd-index is DERIVED (rebuildable from `kb-export/`); the fix is a reindex, never a data-loss event. Runbook: `027-OD-OPSM` §"Search returns 0 hits" + §"Rebuild the search index".                                                                                                                                |

---

## Review Cadence

This risk register is reviewed and updated:

- At each phase completion
- During After Action Reviews (AARs)
- When a new risk is identified during development
- When the status of an existing risk changes

## Risk Definitions

**Likelihood levels**:

- **Low**: Unlikely to occur during the project lifecycle
- **Medium**: May occur; has happened in similar projects
- **High**: Likely to occur; evidence suggests it will happen

**Impact levels**:

- **Low**: Minor inconvenience, easy workaround
- **Medium**: Noticeable disruption, requires effort to resolve
- **High**: Significant setback, major rework required
- **Critical**: Project-threatening, data loss, or security breach

**Status values**:

- **Open**: Risk is identified but mitigation is not yet in place
- **Mitigated**: Controls are in place that reduce likelihood or impact
- **Partially mitigated**: Some controls in place, more needed
- **Accepted**: Risk is acknowledged and no further mitigation is planned
- **Closed**: Risk is no longer relevant (resolved or superseded)
