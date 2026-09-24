# Registrar brain runtime contract

## Contents

- [Search input](#search-input)
- [Runtime variants](#runtime-variants)
- [Result interpretation](#result-interpretation)
- [Authentication and failures](#authentication-and-failures)

## Search input

`teamkb_search` accepts a required non-empty `query`, optional `scope`, and optional integer `limit`
from 1 through 50. Scope is `curated`, `all`, `inbox`, `archived`, or `bulk`; the default is
`curated`.

## Runtime variants

The repository's shipped `.mcp.json` starts `plugin-runtime/teamkb-remote.cjs`. That client exposes
only `teamkb_search` and always calls the configured brain API. It is not the newer unified
`governed-second-brain` plugin, whose corresponding tool is named `brain_search`.

The source-built `apps/mcp-server` exposes the broader Registrar operator surface. Its search tool
uses the API when `TEAMKB_API_URL` is configured and otherwise queries the local qmd index.

## Result interpretation

A search result contains `source`, `query`, `scope`, `count`, and `results`. Hits can include
`citation`, `snippet`, `score`, `title`, and `collection`. Only returned citations may support an
answer.

The remote client returns `source: unconfigured` when no API URL exists. Successful requests and most
other failures use `source: brain-api`; authorization failures, non-2xx responses, malformed network
paths, and transport exceptions currently collapse to an empty result. This legacy ambiguity means an
empty remote result does not prove the corpus is empty.

## Authentication and failures

The remote client reads `TEAMKB_API_TOKEN` and sends it as a bearer token. The source-built local
search path needs no API credential. Never expose a token in a query, answer, log excerpt, or capture.

When a remote miss is unexpected, report the ambiguity and ask an operator to validate service health
and credentials. Do not fabricate a result or claim an outage that the tool response cannot prove.
