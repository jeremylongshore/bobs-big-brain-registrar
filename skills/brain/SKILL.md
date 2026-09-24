---
name: brain
description: |
  Search and analyze Intent Solutions' governed team memory through the Registrar,
  returning qmd:// citations for supported claims. Use when checking recorded
  architecture, infrastructure, decisions, runbooks, or conventions. Trigger with
  "/brain", "ask the team brain", or "check the team knowledge base".
allowed-tools: 'mcp__teamkb__teamkb_search'
version: 1.1.0
author: Intent Solutions <jeremy@intentsolutions.io>
license: Apache-2.0
compatibility: 'Designed for Claude Code; requires the Registrar intent-brain remote plugin with TEAMKB_API_URL and a per-user TEAMKB_API_TOKEN, or a locally built Registrar MCP server exposing teamkb_search. The shipped intent-brain marketplace runtime is remote and read-only.'
tags: [brain, knowledge, search, citations, governance, registrar]
argument-hint: '[question]'
model: inherit
effort: low
---

# Brain — cite the Registrar's governed team memory

Answer questions from the Registrar's governed corpus and attach a returned `qmd://` citation to every
load-bearing claim. Refuse to present unsupported recall as team knowledge.

## Overview

The Registrar is the govern layer of Bob's Big Brain: the Compiler prepares candidate knowledge,
deterministic policy decides what becomes durable, and qmd retrieves the governed result. This skill
uses the Registrar-native `teamkb_search` surface. The unified `governed-second-brain` plugin exposes a
different tool name, `brain_search`; do not mix the two contracts.

## Prerequisites

- Install the public `intent-brain` plugin from this repository for remote, read-only search, or build
  `apps/mcp-server` for the full local operator runtime.
- For the shipped remote plugin, configure `TEAMKB_API_URL` and a per-user `TEAMKB_API_TOKEN`.
- Read [the runtime contract](references/runtime-contract.md) for exact inputs, authentication, modes,
  and failure ambiguity.

## Authentication

The shipped remote client sends `TEAMKB_API_TOKEN` as an `Authorization: Bearer` header to
`TEAMKB_API_URL`. Supply it through the plugin environment and never print, capture, or commit it. A
locally built Registrar server can search a local index without API authentication.

## Instructions

### Step 1: Search curated memory

Derive 1–4 distinctive keywords from the question, dropping generic question words. Call
`teamkb_search` with `scope: "curated"` and an optional `limit` from 1 through 50.

```text
teamkb_search({ query: "Caddy reverse proxy", scope: "curated", limit: 10 })
```

If the result is empty, retry the same keywords once with `scope: "all"`. Use `inbox`, `archived`, or
`bulk` only when the user explicitly requests that uncurated, retired, or bulk-digestion material.

### Step 2: Answer only from results

- Synthesize a short answer from returned snippets.
- Attach the exact returned `qmd://` citation to each supported claim.
- Surface conflicting results with both citations.
- Label reasoning beyond the cited snippets as inference.
- Never invent a citation or silently fill a gap with general knowledge.

### Step 3: Handle no evidence

After the curated-to-all retry, state plainly that no governed evidence was found. The legacy remote
client maps several transport and authorization failures to an empty result, so do not claim that an
empty response proves the corpus lacks the fact; mention this limitation when the miss is unexpected.

## Output

1. Direct answer or honest no-evidence statement.
2. Inline `qmd://` citation after every load-bearing claim.
3. A **Sources** list containing each distinct citation used.

## Examples

```text
/brain what does the system map say about the reverse proxy?

The reverse proxy is the single ingress (qmd://kb-curated/9c2e42f1-7b60-4ed2-a9dd-648d6c786d43.md).

Sources:
- qmd://kb-curated/9c2e42f1-7b60-4ed2-a9dd-648d6c786d43.md
```

If both scopes return no results:

```text
No governed evidence was found for that topic. The legacy remote client can also return an empty set
when the service or credential fails, so an operator should check connectivity if this miss is
unexpected.
```

## Error Handling

| Situation                  | Response                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `source` is `unconfigured` | Configure `TEAMKB_API_URL`; do not describe this as an empty corpus.                                       |
| Empty `brain-api` result   | Complete the scope retry, then state no evidence was returned and note the legacy ambiguity when relevant. |
| Tool is unavailable        | Enable the Registrar `intent-brain` plugin or locally built `teamkb` MCP server.                           |
| User asks to write         | This skill is read-only; use the Registrar operator `brain-save` skill only with the full local server.    |

## Guardrails

- Treat inbox, archive, and bulk results as explicitly requested context, not curated truth.
- Provenance identifies where a capture came from; it does not prove the content is true.
- Prefer a narrow cited answer over a broad unsupported one.

## Resources

- [Bob's Big Brain Registrar](https://github.com/jeremylongshore/bobs-big-brain-registrar)
- [Bob's Big Brain umbrella](https://github.com/intent-solutions-io/bobs-big-brain-umbrella)
- [tobi/qmd](https://github.com/tobi/qmd), the attributed retrieval engine
