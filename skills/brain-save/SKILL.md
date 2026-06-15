---
name: brain-save
description: |
  Saves a single fact, decision, pattern, or convention into the governed knowledge brain so it can be
  recalled later — and (for admins) retires memories that are outdated. Admin-only and side-effecting:
  it writes to the governed corpus, so it never auto-fires — invoke it explicitly. Use when an admin
  wants the brain to remember something specific going forward without a full recompile, or to mark an
  old memory outdated. Trigger with "/brain-save".
allowed-tools: 'mcp__teamkb__teamkb_propose, mcp__teamkb__teamkb_transition, mcp__teamkb__teamkb_status'
version: 1.0.0
author: Intent Solutions <jeremy@intentsolutions.io>
license: Apache-2.0
compatibility: 'Designed for Claude Code; requires the intent-brain plugin installed with admin role (TEAMKB_ROLE=admin)'
tags: [brain, governance, save, capture, admin]
argument-hint: '[save <fact> | retire <memory-id>]'
disable-model-invocation: true
---

# Brain Save — write a fact into the brain (admin only)

This is the **write** side of the brain. `/brain` reads; `/brain-save` writes. Use it to tell the brain
to remember a specific fact going forward — without re-running a full compile — or to retire a memory
that's no longer true.

## Overview

The brain learns in two ways: the bulk **compile** ingests a whole corpus at once, and `/brain-save`
adds (or retires) a **single** item on demand. Either way, governance stays in code: this skill
_proposes_ a memory to the deterministic curator, which decides what actually gets stored after policy
checks (dedupe, secret-detection). You are saving an item for the brain to keep, not bypassing the
governance pipeline.

## Why this never auto-fires

`disable-model-invocation: true` means Claude will not trigger this from conversation — it runs only
when you explicitly type it. Writing to the _shared company brain_ is a deliberate act, not a chat side
effect. The brain API **also** enforces this server-side: the write tools succeed only for an admin
token, returning `403` otherwise. This skill is the convenient front door; the server is the real gate.

## Prerequisites

- The `intent-brain` plugin is installed with **admin** role (`TEAMKB_ROLE=admin`), so the write MCP
  tools are registered. A member install never sees them.
- Team mode: the admin's per-user `TEAMKB_API_TOKEN` must carry the admin role, or the brain API
  rejects the write with `403`.

## Authentication

In team mode the write tools reach the brain API over the tailnet with the admin's per-user bearer
token (`TEAMKB_API_TOKEN`), sent as an `Authorization: Bearer` header. A member token is rejected
server-side with `403`. Never hardcode the token; supply it via env or a `headersHelper`. In local
mode no token is needed.

## Instructions

### Save a new fact

1. Confirm it's worth keeping — _"Would a new teammate benefit from finding this in 30 days?"_ Skip
   ephemeral debugging steps, personal preferences, secrets, or anything already in a CLAUDE.md/README.
2. Pick a category: `decision`, `pattern`, `convention`, `architecture`, `troubleshooting`,
   `onboarding`, or `reference`.
3. Call **`teamkb_propose`** with `{ title, content, category, filePaths? }`. It writes to the spool;
   the curator promotes it after policy checks.

### Retire an outdated memory

1. Find the memory's UUID (via `/brain` search or `teamkb_status`).
2. Call **`teamkb_transition`** with `{ memoryId, to, reason, actor }`. Valid moves:
   `active → {deprecated, superseded, archived}`, `deprecated → {active, archived}`,
   `superseded → archived`. Every transition writes a hash-chained audit event.

### Check brain health

Call **`teamkb_status`** to see counts by lifecycle state and recent rejection feedback before or after
a batch of saves.

## Output

- After a save: report the returned `candidateId` and that it is queued for governance review.
- After a retire: report the new lifecycle state and confirm an audit event was written.
- After a status check: summarize counts by lifecycle state and any recent rejections.

## Examples

**Save a decision:**

```
/brain-save we're going Apache-2.0 on both flagships so the public can self-host.

→ teamkb_propose({ title: "License: Apache-2.0 on both flagships",
                   content: "...", category: "decision" })
→ Saved as candidate 4f3a… — queued for governance review.
```

**Retire a superseded memory:**

```
/brain-save retire memory 9c2e… — superseded by the new deploy runbook.

→ teamkb_transition({ memoryId: "9c2e…", to: "archived",
                      reason: "Superseded by the new deploy runbook", actor: "jeremy" })
→ Memory 9c2e… → archived; audit event written.
```

## Error Handling

| Situation                            | Response                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| Write returns `403`                  | The token is not an admin token. The gate working as designed — do not route around it. |
| Write tools are absent               | The install is `member` role; only an `admin` install registers them.                   |
| `teamkb_transition` rejects the move | The lifecycle state machine forbids it; pick a valid target state.                      |
| Content may contain a secret         | Stop and strip it. Do not rely on the pipeline's secret-detection as the only check.    |

## Guardrails

- Never save content containing secrets, tokens, or credentials.
- `reason` on a retire must be a real, human-readable justification — it lands in the permanent audit
  trail.
- A `403` is the system working as designed, not a bug to work around.

## Resources

- [Compile-Then-Govern](https://github.com/intent-solutions-io/compile-then-govern) — the stack and its governance thesis.
- [qmd-team-intent-kb](https://github.com/jeremylongshore/qmd-team-intent-kb) — the governance plane (this plugin's home).
- The read counterpart: the `/brain` skill (cited, member-safe queries).
