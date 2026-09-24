---
name: teamkb
description: |
  Review, classify, and capture a bounded set of team insights or explicitly
  approved Markdown files through the local Registrar operator tools. This is
  side-effecting and never auto-fires. Use when closing a session, importing a
  small document batch, reviewing existing memory, or checking local brain status.
  Trigger with "/teamkb", "capture this session", or "import these team docs".
allowed-tools: 'Read, Glob, Grep, AskUserQuestion, mcp__teamkb__teamkb_search, mcp__teamkb__teamkb_propose, mcp__teamkb__teamkb_import, mcp__teamkb__teamkb_status'
version: 1.1.0
author: Intent Solutions <jeremy@intentsolutions.io>
license: Apache-2.0
compatibility: 'Designed for Claude Code operators running the built Registrar apps/mcp-server with TEAMKB_TENANT_ID, TEAMKB_BASE_PATH, and TEAMKB_ROLE=admin. The shipped intent-brain marketplace plugin is read-only and does not expose capture or import tools.'
tags: [brain, capture, governance, knowledge, admin, registrar]
argument-hint: '[capture | import GLOB | review QUERY | status]'
disable-model-invocation: true
model: inherit
effort: medium
---

# TeamKB — bounded local Registrar capture

Turn a small, explicit set of durable team insights into local spool proposals. Search before capture,
inspect imports before writing, and report proposals as ungoverned until the curator disposes them.

## Overview

This self-contained operator workflow uses the full locally built Registrar MCP server. It does not
depend on repository subagents, and it does not work with the read-only `intent-brain` marketplace
runtime. Capture and import write candidate files to the local spool; deterministic governance and
promotion happen later in the curator.

## Prerequisites

- Build and configure `apps/mcp-server` from the Registrar repository.
- Set `TEAMKB_TENANT_ID`, `TEAMKB_BASE_PATH`, and `TEAMKB_ROLE=admin`.
- Keep `TEAMKB_API_URL` unset when search and writes must target the same local brain.
- Read [the runtime contract](references/runtime-contract.md) for exact bounds and result semantics.

## Modes

- `capture`: distill up to five durable insights from the current session and explicitly supplied
  files, then propose only new content.
- `import GLOB`: inspect and explicitly approve 1–20 Markdown files before `teamkb_import` queues them.
- `review QUERY`: search only; make no writes.
- `status`: call `teamkb_status`; make no writes.

## Instructions

### Capture a session

1. Review the conversation and use `Read`, `Glob`, or `Grep` only on files the user placed in scope.
2. Select at most five items that would help a teammate after 30 days. Classify each as `decision`,
   `pattern`, `convention`, `architecture`, `troubleshooting`, `onboarding`, or `reference`.
3. Reject ephemeral steps, personal preferences, secrets, and facts already maintained in an
   authoritative README or project instruction file.
4. For each candidate, call `teamkb_search` with 1–4 keywords and `scope: "all"`. Skip covered facts;
   surface contradictions instead of creating a competing memory.
5. Call `teamkb_propose` once for each surviving item. The returned candidate UUID proves only that
   the local spool write succeeded.

### Import Markdown files

1. Require an explicit base directory and glob. Refuse a home directory, repository root, hidden
   credential directory, or an unresolved environment variable as the base.
2. Use `Glob` to resolve the exact set. Accept 1–20 `.md` files; require the user to split larger
   batches.
3. Use `Grep` for common secret markers and `Read` any suspicious file. Exclude credentials, tokens,
   private keys, environment dumps, and empty files.
4. Show the final relative file list and use `AskUserQuestion` for explicit confirmation because
   `teamkb_import` writes every match to the spool.
5. Call `teamkb_import({ glob, basePath })` exactly once. Report `queued`, `failed`, and every failed
   file from `outcomes`; never claim promotion.

### Review or status

- For `review`, call `teamkb_search` with `curated` first and broaden to `all` only if needed. Cite the
  exact returned `qmd://` URIs.
- For `status`, call `teamkb_status` and summarize local counts and recent feedback. Do not print the
  absolute `dbPath` unless explicitly requested.

## Output

- Mode and local tenant context, without secrets or absolute storage paths.
- Proposed or imported candidate UUIDs, categories, and spool disposition.
- Skipped duplicates, conflicts, rejected files, and reasons.
- Clear statement that queued candidates are not governed memory until curator processing.

## Examples

```text
/teamkb capture
Reviewed the session, skipped one README-duplicated fact, and queued two local proposals:
- decision — 4f3a2e0e-0ee4-4f63-b63e-22306c45115a
- pattern — 83e1bc9a-0048-44e7-b70b-52bc7cf6e954
Neither proposal is promoted yet.
```

```text
/teamkb import docs/runbooks/*.md
Resolved 6 Markdown files. After explicit approval, teamkb_import queued 5 and failed 1; the failed
file and error are reported without claiming a partial batch was fully successful.
```

```text
/teamkb review deployment rollback
Searched curated memory first and returned two cited runbook results. No write tools were called.

/teamkb status
Reported local lifecycle/category/tenant counts and recent feedback without exposing the database path.
```

## Error Handling

| Situation                               | Response                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Write tools are absent                  | Use the built local server with `TEAMKB_ROLE=admin`; the shipped marketplace plugin is read-only. |
| Search is unexpectedly empty            | Check the local qmd index and tenant before concluding no memory exists.                          |
| Import resolves 0 or more than 20 files | Stop; correct the glob or split the batch.                                                        |
| Secret-like content is found            | Exclude the file or redact the candidate before any MCP write.                                    |
| A spool write fails                     | Report exact failed outcomes; do not claim they were queued.                                      |

## Guardrails

- Local operating-system permissions are the write security boundary; `TEAMKB_ROLE=admin` is a
  registration gate, not authentication.
- Never broaden an import glob after confirmation.
- Never save secrets or rely solely on downstream policy detection.
- Provenance identifies capture origin, not truth.

## Resources

- [Bob's Big Brain Registrar](https://github.com/jeremylongshore/bobs-big-brain-registrar) — source,
  build instructions, and governance architecture.
- [`apps/mcp-server`](https://github.com/jeremylongshore/bobs-big-brain-registrar/tree/main/apps/mcp-server) —
  the full local operator runtime required by this skill.
- `brain-save` — one-item write workflow; `brain` — read-only cited-query workflow.
