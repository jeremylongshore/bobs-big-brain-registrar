# QMD Team Intent KB — Mega Blueprint

Version: 0.1
Status: Pre-Implementation Blueprint
Purpose: Canonical goal, architecture, scope, success criteria, and execution plan before implementation begins

---

# 1. Project Name

**qmd-team-intent-kb**

**Positioning:**
A governed team memory platform for Claude Code powered by qmd.

---

# 2. Core Problem

Teams using Claude Code and related agentic tooling can generate valuable learnings during implementation, debugging, architecture work, security review, and operational tasks, but those learnings are fragmented across sessions, repos, people, and local environments.

Current pain points:

- useful learnings disappear after the session ends
- team knowledge is trapped in chats, commits, or human memory
- repeated rediscovery wastes time and tokens
- raw agent output is noisy and unsafe as a shared truth source
- local search tools are strong, but team-shared governance is weak
- enterprise deployment requires policy, lifecycle, and review controls

The missing capability is not just "memory."
It is **governed, durable, team-shared memory** that fits real engineering workflows.

---

# 3. Project Goal

Build a production-minded system that allows Claude Code and human contributors to capture meaningful technical learnings, govern them through deterministic rules and curation, make them searchable locally through qmd, and preserve them as durable team knowledge across projects and people.

This system must support:

- team-shared memory
- governance and curation
- local fast retrieval
- enterprise-compatible controls
- phased evolution from strong internal tool to serious platform

---

# 4. Success Definition

## Primary success condition

A developer working in a repo can use natural language to retrieve approved, relevant, durable team knowledge from prior work without being flooded by raw junk, duplicate notes, or unsafe content.

## What success looks like operationally

1. Claude Code can capture candidate learnings during work.
2. Candidate learnings are validated before becoming team memory.
3. Only curated knowledge is returned by default in search.
4. qmd provides fast local retrieval on each machine.
5. The canonical control plane governs lifecycle, dedupe, supersession, and archival.
6. Git acts as a mirror/export/distribution layer, not the canonical database.
7. The system works across multiple repos and projects.
8. Enterprise controls can be layered in without redesigning the system.

## Human test of success

A new engineer can ask:

- "How do we handle auth token refresh here?"
- "What did we learn last time about pgBouncer transaction mode?"
- "What architectural decisions were made around the control plane?"
- "What security concerns have already been identified for hooks and MCP?"

...and receive useful, approved answers from team memory.

---

# 5. Non-Goals

This project is **not** trying to be:

- a fork of qmd
- a replacement for qmd's indexing/search engine
- a prompt-only memory system
- git as the canonical system of record
- a raw session dump collector
- an ungoverned "AI brain"
- a graph-first research project on day one
- a fully autonomous knowledge curator with no human oversight

---

# 6. Core Thesis

The correct architecture is a **hybrid model**:

- **canonical memory control plane**
- **local qmd edge indexes**
- **Claude Code policy/runtime layer**
- **git export mirror**
- **curated-only default search**

In this model:

- Claude Code proposes memory
- deterministic code and policy decide what becomes durable memory
- qmd serves as the local retrieval/index engine
- git mirrors curated knowledge for portability and auditability
- inbox/archive do not pollute default search

---

# 7. Architectural Principles

## 7.1 Governance over raw capture

Not every captured learning should become shared memory.

## 7.2 Curated-only default retrieval

Default search must prefer high-signal, approved knowledge.

## 7.3 Local-first retrieval

Search must remain fast and usable on developer machines.

## 7.4 Central truth, distributed access

Canonical state belongs to the control plane; edge indexes serve local consumption.

## 7.5 Deterministic enforcement over prompt obedience

Hooks, validation, policy, and curation logic matter more than wishful CLAUDE.md wording.

## 7.6 Append-only history with lifecycle state

Knowledge should be traceable, supersedable, and archivable without losing provenance.

## 7.7 Enterprise-ready from the start

Security, contribution rules, release discipline, and auditability must be first-class.

---

# 8. High-Level System Design

## 8.1 Claude Runtime Layer

Responsible for:

- capture of candidate learnings
- local policy checks
- route resolution for project/repo context
- writing candidate events to local spool
- keeping interactive developer workflows fast

This layer is where Claude Code hooks, repo rules, CLAUDE.md guidance, and internal workflows live.

## 8.2 Local Spool Layer

Responsible for:

- buffering candidate memory events locally
- handling offline or failed delivery scenarios
- preventing direct writes to canonical memory
- storing failed or redaction-audit artifacts

Example local buckets:

- spool
- failed
- redaction-audit

## 8.3 Canonical Memory Control Plane

Responsible for:

- canonical state and lifecycle
- validation and normalization
- dedupe and supersession
- promotion from candidate to curated memory
- analytics and reporting
- archival rules
- export to git mirror

This is the source of truth.

## 8.4 qmd Edge Layer

Responsible for:

- local indexing and retrieval
- collection strategy
- curated search experience
- local natural-language access
- keeping search fast on developer machines

qmd remains the edge engine, not the canonical database.

## 8.5 Git Export Mirror

Responsible for:

- portable readable export
- auditability
- backup/distribution
- optional team sync patterns
- preserving curated knowledge as human-readable artifacts

Git is the mirror, not the system of record.

---

# 9. Knowledge Lifecycle Model

## Statuses

- candidate
- promoted
- canonical
- superseded
- archived

## Buckets

- inbox
- curated
- archive

## Rule of retrieval

Default search must use:

- curated
- decisions
- guides

Default search must exclude:

- inbox
- archive

This is one of the most important design decisions in the whole system.

---

# 10. Repo Blueprint

## Monorepo structure

```text
qmd-team-intent-kb/
  apps/
    api/
    curator/
    edge-daemon/
    git-exporter/
    reporting/
  packages/
    schema/
    qmd-adapter/
    claude-runtime/
    policy-engine/
    repo-resolver/
    common/
  kb-export/
  .claude/
  .github/
  scripts/
  examples/
  tests/
  000-docs/
```

## Why monorepo first

- shared schema remains coherent
- integration work is easier early
- phase boundaries will shift during early implementation
- docs, CI, contribution rules, and Beads stay unified

---

# 11. Core Modules

## 11.1 packages/schema

Defines canonical models, validation, lifecycle states, and typed records.

## 11.2 packages/qmd-adapter

Clean wrapper around qmd usage for:

- index initialization
- collection setup
- update
- embed
- query/search
- status/health

## 11.3 packages/claude-runtime

Owns:

- hook templates
- CLAUDE.md templates/guidance
- runtime capture helpers
- local spool interfaces

## 11.4 packages/policy-engine

Owns:

- acceptance rules
- redaction logic
- scoring
- promotion logic
- dedupe/supersession rules
- lifecycle policy

## 11.5 packages/repo-resolver

Maps current repo/project context into canonical metadata.

## 11.6 apps/api

Canonical memory control plane API.

## 11.7 apps/curator

Curation worker/pipeline for candidate promotion, dedupe, supersession, and archival.

## 11.8 apps/edge-daemon

Local machine helper for spool processing, edge update behavior, and local integration flow.

## 11.9 apps/git-exporter

Exports curated/approved knowledge into git-readable structures.

## 11.10 apps/reporting

Analytics, reports, health views, and lifecycle reporting.

---

# 12. Security Thesis

Security is not bolt-on. It is part of the project's reason for existing.

## Key security concerns

- secrets accidentally written into memory candidates
- untrusted MCP server patterns
- cross-project contamination of local indexes
- inbox/archive leakage into default search
- prompt-only governance failures
- malicious or sloppy hook behavior
- unclear provenance of curated knowledge
- release artifact trust and integrity
- enterprise enforcement gaps

## Security posture

- validate before persist
- redact before promote
- isolate local index usage
- document managed policy expectations
- keep curated default retrieval strict
- keep git export human-readable and auditable
- never treat raw candidate output as truth

---

# 13. Contribution and Operational Thesis

This repo must be contributor-ready from the beginning.

## Required operating patterns

- feature branches
- solid commit messages
- Beads as required tracker
- flat durable docs under 000-docs/
- AARs at phase completion
- changelog discipline
- release discipline
- testing and CI early
- clear distinction between scaffolded and implemented behavior

## Internal workflows that must be first-class

- /doc-filing
- /beads
- /release

---

# 14. Changelog and Release Thesis

Use:

- Semantic Versioning
- Keep a Changelog style structure

The changelog must be:

- human-readable
- grouped by meaningful categories
- aligned to versioned releases
- disciplined from day one

No garbage entries.
No vague "misc updates."
No pretending initial scaffolding is the same as real delivered capability.

---

# 15. Phased Execution Plan

## Phase 0 — Startup / Standards / Governance

Create the repo foundation, docs, contribution standards, Beads, CI baseline, changelog policy, and security posture.

## Phase 1 — Core Schema / Domain Model

Define the canonical types, lifecycle states, transition rules, and example records.

## Phase 2 — Claude Runtime Capture / Local Spool

Implement candidate capture, hook/runtime templates, local spool model, validation, and basic redaction guardrails.

## Phase 3 — qmd Adapter / Local Edge Index

Implement the qmd integration layer, collection strategy, dedicated edge index, and status/health surface.

## Phase 4 — Control Plane API / Canonical Store

Build the canonical service and persistence layer for candidate intake and lifecycle ownership.

## Phase 5 — Curator / Promotion / Dedupe / Supersession

Implement policy-driven promotion, duplicate handling, canonicalization, and supersession logic.

## Phase 6 — Git Export Mirror

Export curated knowledge into readable git-backed artifacts.

## Phase 7 — Reporting / Analytics / Lifecycle

Build reports, risk views, stale knowledge detection, and lifecycle summaries.

## Phase 8 — Security / Enterprise Hardening

Add stronger policy controls, managed settings assumptions, auditability, and enterprise deployment readiness.

## Phase 9 — Release Readiness / Packaging / Operability

Prepare the repo for stable releases, packaging, and broader team adoption.

---

# 16. Success Metrics

## Functional success metrics

- candidate events can be captured deterministically
- canonical lifecycle states work correctly
- curated knowledge is searchable locally through qmd
- inbox/archive are excluded by default
- git export produces readable artifacts
- analytics/reporting are possible from canonical metadata

## Quality success metrics

- tests exist and pass for implemented modules
- docs remain truthful and coherent
- changelog discipline is maintained
- release/versioning rules are followed
- Beads reflect the actual implementation story

## Product success metrics

- developers can retrieve prior team learnings with natural language
- repeated rediscovery decreases
- low-value memory noise is controlled
- security/governance concerns are reduced, not amplified

---

# 17. Risks Register Summary

## Highest risks

1. Over-trusting prompts instead of deterministic enforcement
2. Polluting retrieval with raw low-signal memory
3. Treating qmd as the canonical database
4. Letting git become the operational event bus
5. Shipping security boilerplate instead of real protections
6. Under-investing in lifecycle and archival policy
7. Building too much magic before stabilizing schema and policy
8. Losing clarity between scaffolding and real implementation

## Mitigation stance

- strong schema first
- curated-only search first
- control plane as truth
- qmd as edge engine
- git as export/mirror
- phased implementation
- honest docs and AARs

---

# 18. Decision Summary

The key decisions locked in before implementation:

## Decision 1

This project is not a qmd fork.

## Decision 2

This project is not git as the canonical database.

## Decision 3

This project uses a hybrid architecture:
control plane + qmd edge + Claude runtime + git export mirror.

## Decision 4

Default search targets curated knowledge only.

## Decision 5

Hooks and deterministic code enforce policy; CLAUDE.md guides behavior.

## Decision 6

Security, changelog discipline, release hygiene, Beads, doc filing, and AARs are first-class from day one.

---

# 19. Final Blueprint Statement

qmd-team-intent-kb will be built as a governed, enterprise-capable team memory platform for Claude Code.

Its job is not merely to store notes.
Its job is to turn meaningful technical learnings into durable, searchable, governed team knowledge.

The system will succeed if it makes prior engineering insight easy to retrieve, hard to lose, and difficult to corrupt with noise.

That is the standard implementation must now meet.
