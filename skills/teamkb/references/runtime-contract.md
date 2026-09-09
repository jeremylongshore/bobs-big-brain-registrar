# TeamKB operator runtime contract

## Contents

- [Runtime and tools](#runtime-and-tools)
- [Capture contract](#capture-contract)
- [Import contract](#import-contract)
- [Safety bounds](#safety-bounds)

## Runtime and tools

This workflow requires the source-built `apps/mcp-server` with `TEAMKB_ROLE=admin`. The repository's
shipped `intent-brain` marketplace runtime is read-only and exposes none of the write tools used here.

Search can be local or remote, but `teamkb_propose`, `teamkb_import`, and `teamkb_status` always use
the local `TEAMKB_BASE_PATH`. Leave `TEAMKB_API_URL` unset to keep the workflow on one local brain.

## Capture contract

`teamkb_propose` accepts required `title` and `content`, plus optional `category` and `filePaths`. It
writes one candidate to the spool and returns `candidateId` plus a queued message. It does not execute
the curator or prove promotion.

Search-before-capture uses `teamkb_search` with `scope: all` to reduce duplicates. Search results may
contain uncurated or retired material in that scope; use them for conflict detection, not as automatic
truth.

## Import contract

`teamkb_import` accepts a required glob and optional base path. It resolves files with `fast-glob`,
reads each matched file as UTF-8, rejects unreadable or empty files individually, and writes one spool
candidate per successful file. Its result contains aggregate `queued` and `failed` counts plus an
`outcomes` record for every file.

The runtime itself has no batch-size ceiling and no pre-import confirmation. The skill therefore caps
one invocation at 20 Markdown files, resolves the exact list before calling the tool, scans for likely
secrets, and requires explicit approval of that unchanged list.

## Safety bounds

- Never use a home directory, repository root, hidden credential directory, unresolved variable, or
  filesystem root as an import base.
- Never broaden the approved glob between preview and write.
- Treat partial import as partial success and report each failed outcome.
- Do not print absolute local storage paths unless the operator explicitly requests them.
- Candidate provenance records origin; it does not certify factual accuracy.
