---
name: brain-save
description: |
  Create and manage one governed Registrar memory by proposing a durable fact or
  applying a supported lifecycle transition. This is a local operator write and
  never auto-fires. Use when an administrator needs to preserve one team fact or
  retire an outdated memory. Trigger with "/brain-save".
allowed-tools: 'mcp__teamkb__teamkb_search, mcp__teamkb__teamkb_propose, mcp__teamkb__teamkb_transition, mcp__teamkb__teamkb_status'
version: 1.1.0
author: Intent Solutions <jeremy@intentsolutions.io>
license: Apache-2.0
compatibility: 'Designed for Claude Code operators running the built Registrar apps/mcp-server with TEAMKB_TENANT_ID, TEAMKB_BASE_PATH, and TEAMKB_ROLE=admin. The shipped intent-brain marketplace plugin is read-only and does not expose these write tools.'
tags: [brain, governance, save, capture, admin, registrar]
argument-hint: '[save <fact> | retire <memory-id> | status]'
disable-model-invocation: true
model: inherit
effort: medium
---

# Brain Save — write one local Registrar memory proposal

Propose one fact to the local Registrar spool or apply one supported lifecycle transition. Never claim
that a queued proposal is already governed or searchable.

## Overview

This is the full Registrar operator surface, not the read-only `intent-brain` marketplace runtime and
not the unified `governed-second-brain` plugin. `teamkb_propose`, `teamkb_transition`, and
`teamkb_status` operate on the local paths configured for `apps/mcp-server`, even when remote search is
configured. Keep `TEAMKB_API_URL` unset when the search and write sides must address the same brain.

## Prerequisites

- Build and configure `apps/mcp-server` from this repository.
- Set `TEAMKB_TENANT_ID`, `TEAMKB_BASE_PATH`, and `TEAMKB_ROLE=admin`.
- Protect the local base path with operating-system permissions; `TEAMKB_ROLE=admin` is a tool
  registration gate, not remote authentication.
- Read [the runtime contract](references/runtime-contract.md) before operating mixed local/remote mode.

## Instructions

### Save a new fact

1. Search first with `teamkb_search({ query: "KEY_TERMS", scope: "all" })`. If existing governed
   content already covers the fact, stop instead of duplicating it.
2. Exclude ephemeral debugging, personal preferences, secrets, credentials, and facts already
   maintained in authoritative project documentation.
3. Choose `decision`, `pattern`, `convention`, `architecture`, `troubleshooting`, `onboarding`, or
   `reference`.
4. Call `teamkb_propose` with `{ title, content, category, filePaths? }`.
5. Report the returned `candidateId` as queued to the local spool. Promotion happens only when the
   separate curator processes it; this skill does not run or prove that step.

### Retire or restore a memory

1. Search for the memory and extract its UUID from a UUID-shaped citation filename such as
   `qmd://kb-curated/9c2e42f1-7b60-4ed2-a9dd-648d6c786d43.md`.
2. Call `teamkb_transition` with `{ memoryId, to, reason, actor }`.
3. Use only transitions the current tool can complete safely: `active` to `deprecated` or `archived`,
   `deprecated` to `active` or `archived`, and `superseded` to `archived`.
4. Do not request `active` to `superseded` through this version of the MCP tool; its input surface
   cannot supply the required replacement-memory link.

### Check local status

Call `teamkb_status` for local database counts and recent governance feedback. Status does not list
spool proposals and cannot confirm that a newly queued candidate has been promoted.

## Output

- Save: candidate UUID, local-spool disposition, and an explicit “not yet promoted” statement.
- Transition: memory UUID, old and new lifecycle states, and audit-event UUID.
- Status: counts by lifecycle/category/tenant and recent feedback, without printing `dbPath` unless the
  operator explicitly requests it.

## Examples

```text
teamkb_search({ query: "Apache license", scope: "all" })
teamkb_propose({
  title: "License: Apache-2.0 across public engines",
  content: "The public engines use Apache-2.0.",
  category: "decision"
})

Candidate 4f3a2e0e-0ee4-4f63-b63e-22306c45115a was queued locally. It is not governed memory until the
curator processes it.
```

```text
teamkb_transition({
  memoryId: "9c2e42f1-7b60-4ed2-a9dd-648d6c786d43",
  to: "deprecated",
  reason: "Replaced by the current deployment runbook",
  actor: "registrar-operator"
})

Memory 9c2e42f1-7b60-4ed2-a9dd-648d6c786d43 moved from active to deprecated; audit event
83e1bc9a-0048-44e7-b70b-52bc7cf6e954 recorded the transition.
```

## Error Handling

| Situation                        | Response                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| Write tools are absent           | The read-only plugin or member role is active; use the built local server with `TEAMKB_ROLE=admin`. |
| Spool write fails                | Report the error; do not claim the candidate was queued.                                            |
| Transition ID is not UUID-shaped | Stop and obtain an exact ID from a returned citation.                                               |
| Transition is rejected           | Report the state-machine reason; do not route around it.                                            |
| Content may contain a secret     | Strip it before calling `teamkb_propose`; policy scanning is not the only control.                  |

## Guardrails

- Never persist secrets, tokens, credentials, or private keys.
- Require a human-readable transition reason and a truthful actor identifier.
- Local filesystem access is the security boundary for writes; a bearer token does not authorize this
  tool path.
- Provenance proves capture origin, not factual truth.

## Resources

- [Bob's Big Brain Registrar](https://github.com/jeremylongshore/bobs-big-brain-registrar) — source,
  build instructions, and operator documentation.
- [`apps/mcp-server`](https://github.com/jeremylongshore/bobs-big-brain-registrar/tree/main/apps/mcp-server) —
  the required full operator runtime.
- `brain` — read counterpart using the Registrar-native `teamkb_search` tool.
