---
name: teamkb
description: |
  Runs an end-of-session capture sweep for the governed knowledge brain: reviews what
  happened, classifies insights, checks for conflicts, and proposes governed memories
  via the teamkb MCP tools. Admin capture workflow that complements the one-shot
  /brain-promote. Use when wrapping up a session with team-relevant discoveries, or
  when importing existing docs into the brain. Trigger with "/teamkb", "capture this
  session", or "sweep for team knowledge".
allowed-tools: 'Read, Glob, Grep, Agent'
version: 1.0.0
author: Intent Solutions <jeremy@intentsolutions.io>
license: Apache-2.0
compatibility: 'Designed for Claude Code; requires the intent-brain plugin with admin role (TEAMKB_ROLE=admin) for the write tools'
tags: [brain, capture, governance, knowledge, admin]
argument-hint: '[capture | import | status | review]'
---

# TeamKB — governed team-knowledge capture sweep

Capture team memory at the end of a session: review what happened, classify the
insights worth keeping, check them against existing memories for conflicts, and queue
them for governance review. This is the multi-step, subagent-driven capture workflow
that sits alongside the one-shot `/brain-promote`.

## Overview

The brain captures knowledge, validates it through deterministic governance policies,
and shares it across the team via qmd. This skill drives the **capture** side: it uses
the `teamkb` MCP tools to propose candidates (never writing governed state directly —
the curator promotes after policy checks) and delegates the judgment-heavy steps to
specialized subagents.

## Prerequisites

- The `intent-brain` plugin is installed with **admin** role (`TEAMKB_ROLE=admin`), so
  the write MCP tools (`teamkb_propose`, `teamkb_status`) are registered. A member
  install is read-only and cannot capture.
- For conflict checking, the brain has an existing corpus to compare against.

## Authentication

In team mode, the write tools reach the brain API over the tailnet with the admin's
per-user bearer token (`TEAMKB_API_TOKEN`), sent as an `Authorization: Bearer` header.
A non-admin token is rejected server-side with `403`. Never hardcode the token; supply
it via env or a `headersHelper`. In local mode no token is needed.

## Available MCP tools

- **teamkb_propose** — capture a single insight as a candidate `{ title, content, category?, filePaths? }`. Writes to the spool; the governance pipeline decides promotion.
- **teamkb_import** — bulk-import files as candidates `{ glob, basePath? }`.
- **teamkb_status** — counts by lifecycle state, category, and recent rejection feedback.
- **teamkb_transition** — change a memory's lifecycle state `{ memoryId, to, reason, actor }`.

## Instructions

### Step 1: Review the session

Use `Read`, `Glob`, and `Grep` to gather what changed and what was decided — the diff,
the files touched, and any decisions stated in the conversation. Delegate the sweep to
the **@teamkb-scout** subagent (via `Agent`) when the session is large.

### Step 2: Classify each candidate insight

Recognize capturable moments and assign a category:

1. Decisions made ("Let's use X instead of Y because…") → `decision`
2. Patterns discovered ("This pattern works well for…") → `pattern`
3. Conventions agreed ("We should always…") → `convention`
4. Architecture documented ("The data flows from…") → `architecture`
5. Bugs solved ("The root cause was…") → `troubleshooting`
6. Setup documented ("To get this running…") → `onboarding`

Delegate ambiguous content to **@teamkb-classifier**.

### Step 3: Check for conflicts

Before proposing, delegate to **@teamkb-conflict-checker** to compare each candidate
against existing memories. Surface conflicts rather than creating duplicates or
contradictions — the governance layer tracks contradictions explicitly.

### Step 4: Propose

For each surviving candidate, call `teamkb_propose`. Then call `teamkb_status` to
confirm the candidates landed and review any recent rejection feedback.

## Quality bar

Before proposing, ask: **"Would a new team member benefit from finding this in 30 days?"**
Do NOT propose:

- Session-specific debugging steps (too ephemeral)
- Personal preferences (not team knowledge)
- Content already in CLAUDE.md or README
- Anything containing secrets, tokens, or credentials

## Subagents

- **@teamkb-scout** — sweeps the session for capturable moments.
- **@teamkb-curator** — end-of-session capture orchestration.
- **@teamkb-classifier** — categorizes ambiguous content into a MemoryCategory.
- **@teamkb-conflict-checker** — compares a proposed memory against existing ones.

## Output

- A list of proposed candidates with their categories and returned `candidateId`s.
- Any conflicts surfaced (and how they were resolved).
- A closing `teamkb_status` summary.

## Error Handling

| Situation                      | Response                                                              |
| ------------------------------ | --------------------------------------------------------------------- |
| Write tools absent             | The install is `member` role; capture requires an `admin` install.    |
| Propose returns `403`          | The token is not an admin token — the gate working as designed.       |
| Candidate may contain a secret | Strip it; do not rely on pipeline secret-detection as the only check. |

## Examples

```
/teamkb capture
→ @teamkb-curator reviews the session, proposes 3 candidates (1 decision, 2 patterns).

/teamkb import docs/**/*.md
→ Bulk-imports matching files as candidates queued for governance review.

/teamkb status
→ Shows counts by lifecycle state and recent rejection feedback.
```

## Resources

- The read counterpart: the `/brain` skill (cited, member-safe queries).
- The one-shot capture: the `/brain-promote` skill.
- [qmd-team-intent-kb](https://github.com/jeremylongshore/qmd-team-intent-kb) — the governance plane.
