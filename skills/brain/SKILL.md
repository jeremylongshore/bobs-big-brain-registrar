---
name: brain
description: |
  Answers questions about Intent Solutions' own systems, decisions, runbooks, and
  conventions from the governed knowledge brain, returning a qmd:// citation for
  every claim — receipts, not recall. Use when a teammate asks what the team knows
  about its own architecture, infrastructure, decisions, or conventions (e.g.
  "what does our system map say about the Caddy block", "why did we pick Apache-2.0",
  "how does the brain auth work", "what is our deploy runbook"). Trigger with "/brain",
  "ask the brain", "what do we know about", "what does our system map say", or "check
  the team knowledge base".
allowed-tools: 'mcp__teamkb__teamkb_search'
version: 1.0.0
author: Intent Solutions <jeremy@intentsolutions.io>
license: Apache-2.0
compatibility: 'Designed for Claude Code; requires the intent-brain plugin (auto-wires the teamkb MCP server)'
tags: [brain, knowledge, search, citations, governance]
argument-hint: '[question]'
---

# Brain — cited answers from the governed knowledge base

Ask the Intent Solutions knowledge **brain** a question and get an answer grounded
in the governed corpus, where **every claim carries a qmd:// citation**. The brain
does not paraphrase from memory — it retrieves governed memories and cites them, so
any answer is verifiable after the fact.

## Overview

This is the read surface of the Compile-Then-Govern stack: ICO **compiles** raw
material into governed memories, INTKB **governs** them, and qmd **retrieves** them
with citations. The `teamkb_search` MCP tool fronts that retrieval. The job here is
to turn a natural-language question into a cited answer — and to refuse to answer
beyond what the citations support.

## Prerequisites

- The `intent-brain` plugin is installed, which auto-wires the `teamkb` MCP server.
- Team mode: `TEAMKB_API_URL` points at the brain on the dev box, and the teammate's
  per-user `TEAMKB_API_TOKEN` is set. Local mode: neither is set, and search runs
  against the local `~/.teamkb` index.

## Authentication

In team mode, `teamkb_search` reaches the brain API over the tailnet with a per-user
bearer token. The token is supplied as `TEAMKB_API_TOKEN` (set once via env or a
`headersHelper` script) and is sent as an `Authorization: Bearer` header by the MCP
server — never hardcode it in committed config. In local mode no token is needed;
search runs in-process against the local qmd index. This skill never handles the
token directly; it only calls the MCP tool, which carries the credential.

## Instructions

### Step 1: Search the governed corpus

Call **`teamkb_search`** with the user's question as `query`. Keep `scope` at its
default (`curated`) unless the user explicitly asks for inbox/archived material —
curated is the governed, promoted knowledge.

```
teamkb_search({ query: "the user's question, lightly cleaned up", scope: "curated" })
```

The tool returns `{ source, results: [{ citation, snippet, score, collection }] }`.
Each `citation` is a `qmd://COLLECTION/FILENAME` URI — the receipt for that hit.

### Step 2: Answer ONLY from the cited results

- Synthesize a direct answer from the returned snippets.
- **Attach the qmd:// citation to every claim**, inline — for example:
  `The Caddy block reverse-proxies the API (qmd://kb-curated/system-map.md).`
- If two hits conflict, surface both with their citations rather than silently
  picking one — the governance layer tracks contradictions; do not paper over them.
- **Do not add knowledge the citations do not support.** Any reasoning beyond the
  corpus must be labeled clearly as inference, not the brain's answer.

### Step 3: Handle an empty result honestly

If `results` is empty, say so plainly: the brain has nothing governed on that topic.
Do **not** fall back to general knowledge and present it as the team's answer.
Optionally note that the topic may need to be saved (an admin runs `/brain-save`).

## Output

1. A short, direct answer.
2. Each load-bearing claim followed by its qmd:// citation.
3. A closing **Sources** list of the distinct qmd:// URIs used.

## Examples

**Cited answer:**

```
/brain what does our system map say about the Caddy block?

→ Caddy is the single ingress; it reverse-proxies each domain to its container
  and must be reloaded, not restarted, after edits (qmd://kb-curated/system-map.md).

Sources:
- qmd://kb-curated/system-map.md
```

**Empty result (honest refusal):**

```
/brain what is our refund policy?

→ The brain has nothing governed on a refund policy. I won't guess from general
  knowledge. If this should be team knowledge, an admin can capture it with
  /brain-save.
```

## Error Handling

| Situation                                         | Response                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `teamkb_search` returns empty `results`           | State the brain has nothing governed; do not fabricate.                               |
| Tool reports `source: "brain-api"` with 0 results | The remote brain answered but had no match — treat as empty, not as an error.         |
| MCP tool unavailable                              | The plugin/MCP server is not enabled; tell the user to install/enable `intent-brain`. |
| User asks to write/capture                        | Out of scope here — direct them to `/brain-save` (admin-only).                        |

## Guardrails

- Read-only. This skill never writes to the corpus — capture and promotion are
  admin-only (`/brain-save`).
- Never invent a qmd:// URI. Cite only URIs returned by `teamkb_search`.
- Prefer fewer, well-cited claims over a broad answer that cannot be anchored.

## Resources

- [Compile-Then-Govern](https://github.com/intent-solutions-io/compile-then-govern) — the stack this brain belongs to.
- [intentional-cognition-os](https://github.com/jeremylongshore/intentional-cognition-os) — the compiler (ICO).
- [qmd-team-intent-kb](https://github.com/jeremylongshore/qmd-team-intent-kb) — the governance + retrieval plane (this plugin's home).
