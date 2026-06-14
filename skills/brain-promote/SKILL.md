---
name: brain-promote
description: |
  Captures a team insight into the governance pipeline and (for admins) promotes or
  transitions governed memories in the knowledge brain. Admin-only and side-effecting:
  it writes to the spool and changes governed state, so it never auto-fires — invoke it
  explicitly. Use when an admin wants to record a decision, pattern, convention, or
  runbook into the brain, or move a memory through its lifecycle. Trigger with
  "/brain-promote".
allowed-tools: 'mcp__teamkb__teamkb_propose, mcp__teamkb__teamkb_transition, mcp__teamkb__teamkb_status'
version: 1.0.0
author: Intent Solutions <jeremy@intentsolutions.io>
license: Apache-2.0
compatibility: 'Designed for Claude Code; requires the intent-brain plugin installed with admin role (TEAMKB_ROLE=admin)'
tags: [brain, governance, promote, capture, admin]
argument-hint: '[capture <insight> | transition <memory-id> <state>]'
disable-model-invocation: true
---

# Brain Promote — capture and govern (admin only)

Record a team insight into the governed brain, or move an existing memory through its
lifecycle. This is the **write** surface of the Compile-Then-Govern stack, and it is
deliberately gated: members read (`/brain`), admins capture and promote.

## Overview

The brain separates proposing from governing. This skill proposes (writes a candidate
to the spool) and transitions (moves a governed memory through its lifecycle). The
deterministic curator — not this skill — decides what gets promoted, after policy
checks (dedupe, secret-detection, trust). The skill is the front door; governance
stays in code.

## Why this never auto-fires

`disable-model-invocation: true` means Claude will not trigger this from conversational
intent — it runs only when explicitly invoked. Writing to the governed corpus is a
deliberate act, not a side effect of a chat. The brain API **also** enforces this
server-side: `teamkb_propose` and `teamkb_transition` succeed only for an admin token,
returning `403` otherwise. This skill is the convenient front door; the server is the
real gate.

## Prerequisites

- The `intent-brain` plugin is installed with **admin** role (`TEAMKB_ROLE=admin`), so
  the write MCP tools are registered. A member install never sees them.
- Team mode: the admin's per-user `TEAMKB_API_TOKEN` must carry the admin role, or the
  brain API rejects the write with `403`.

## Authentication

In team mode, the write tools reach the brain API over the tailnet with the admin's
per-user bearer token (`TEAMKB_API_TOKEN`), sent as an `Authorization: Bearer` header.
A member token is rejected server-side with `403` regardless of client configuration.
Never hardcode the token in committed config — supply it via env or a `headersHelper`.

## Instructions

### Capture a new memory (propose)

1. Confirm the insight is worth governing — ask: _"Would a new teammate benefit from
   finding this in 30 days?"_ Skip ephemeral debugging steps, personal preferences,
   secrets, or anything already in a CLAUDE.md/README.
2. Classify it: `decision`, `pattern`, `convention`, `architecture`, `troubleshooting`,
   `onboarding`, or `reference`.
3. Call **`teamkb_propose`** with `{ title, content, category, filePaths? }`. This writes
   to the spool only — the curator promotes it after policy checks. You are proposing,
   not bypassing governance.

### Transition an existing memory (lifecycle)

1. Find the memory's UUID (via `/brain` search or `teamkb_status`).
2. Call **`teamkb_transition`** with `{ memoryId, to, reason, actor }`. Valid moves:
   `active → {deprecated, superseded, archived}`, `deprecated → {active, archived}`,
   `superseded → archived`. Every transition writes a hash-chained audit event.

### Check governance health

Call **`teamkb_status`** to see counts by lifecycle state and recent rejection feedback
before or after a batch of proposals.

## Output

- After a propose: report the returned `candidateId` and state that it is queued for
  governance review (not yet promoted).
- After a transition: report the new lifecycle state and confirm an audit event was
  written.
- After a status check: summarize counts by lifecycle state and any recent rejections.

## Examples

**Capture a decision:**

```
/brain-promote capture: we chose Apache-2.0 for both flagships so the public can self-host.

→ teamkb_propose({ title: "License: Apache-2.0 on both flagships",
                   content: "...", category: "decision" })
→ Candidate 4f3a… queued for governance review.
```

**Archive a superseded memory:**

```
/brain-promote archive memory 9c2e… — superseded by the new deploy runbook.

→ teamkb_transition({ memoryId: "9c2e…", to: "archived",
                      reason: "Superseded by the new deploy runbook", actor: "jeremy" })
→ Memory 9c2e… → archived; audit event written.
```

## Error Handling

| Situation                            | Response                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Write returns `403`                  | The token is not an admin token. This is the gate working as designed — do not route around it. |
| Write tools are absent               | The install is `member` role; only an `admin` install registers them.                           |
| `teamkb_transition` rejects the move | The lifecycle state machine forbids it; pick a valid target state.                              |
| Content may contain a secret         | Stop and strip it. Do not rely on the pipeline's secret-detection as the only check.            |

## Guardrails

- Never propose content containing secrets, tokens, or credentials.
- `reason` on a transition must be a real, human-readable justification — it lands in
  the permanent audit trail.
- A `403` is the system working as designed, not a bug to work around.

## Resources

- [Compile-Then-Govern](https://github.com/intent-solutions-io/compile-then-govern) — the stack and its governance thesis.
- [qmd-team-intent-kb](https://github.com/jeremylongshore/qmd-team-intent-kb) — the governance plane (this plugin's home).
- The read counterpart: the `/brain` skill (cited, member-safe queries).
