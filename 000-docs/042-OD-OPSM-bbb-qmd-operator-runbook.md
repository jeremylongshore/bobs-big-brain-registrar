# 042-OD-OPSM — Bob's Big Brain + Tobi qmd operator runbook

**Status:** Active
**Date:** 2026-08-02
**Audience:** operators / agents on a box with `~/.teamkb`

## Product shape

| Layer    | What                                 | Who owns it                   |
| -------- | ------------------------------------ | ----------------------------- |
| Retrieve | **Tobi's qmd** (`@tobilu/qmd`)       | Upstream; we pin + Dependabot |
| Govern   | INTKB → `teamkb.db` + export + audit | Intent Solutions              |
| Compile  | ICO (optional)                       | Intent Solutions              |
| Package  | `bobs-big-brain-plugin` MCP          | Intent Solutions              |

**Do not fork qmd** for branding. The product is Bob's Big Brain; the engine is attributed ("Powered by tobi/qmd").

## Personal qmd vs team brain

|                              | Personal                        | Team brain (BBB)                                      |
| ---------------------------- | ------------------------------- | ----------------------------------------------------- |
| Binary on this monorepo      | —                               | Prefer `node_modules/.bin/qmd` (**pin**, today 2.5.3) |
| Bare PATH (`~/.bun/bin/qmd`) | Often **2.0.1**, empty index    | **Wrong home** if used without XDG                    |
| Config / index               | `~/.config/qmd`, `~/.cache/qmd` | `~/.teamkb/qmd-index/<tenant>/{config,cache}`         |
| Wrapper                      | —                               | **`scripts/bbb-qmd`**                                 |

## Commands

```bash
# From qmd-team-intent-kb checkout after pnpm install:
./scripts/bbb-qmd --which          # show binary + XDG + tenant
./scripts/bbb-qmd status           # should show ~2k docs for intent-solutions
./scripts/bbb-qmd search -- SOPS

# Search health (fail loud if index empty/stale):
pnpm search-canary                 # exit 1 if degraded
pnpm search-canary -- --heal       # reindex from kb-export then re-check
# (or) node packages/qmd-adapter/dist/cli.js canary --heal

# Rebuild derived index only (never touches teamkb.db):
pnpm reindex
```

Tenant default: `TEAMKB_TENANT_ID=intent-solutions`.

## Auto-update when Tobi releases

1. Dependabot weekly opens PR when `@tobilu/qmd` bumps (not ignored).
2. CI runs adapter tests + retrieval eval + canary against workspace bin.
3. Merge pin → operators use `bbb-qmd` (pinned bin), not stale PATH.
4. Plugin `gsb.lock.json` retrieve version bumped on plugin release after smoke.

## MCP / agent search

`brain_search` already uses the adapter (tenant XDG + `qmd search --json`).  
If search returns empty: run `pnpm search-canary -- --heal`, confirm `bbb-qmd status`.

## Onboarding eval

See `000-docs/043-OD-EVAL-onboarding-qbank-v1.md` for the outsider question bank and baseline.

## Broad and bulk spool admission

Spool files carrying more than 100 candidates, or any candidate stamped
`source: bulk_import`, are broad-import material. Registrar refuses them before
insertion unless the manifest has a verified `batchReceipt` with:

- `batchId`, `tenantId`, and discovery `scope` (`wiki`, `outputs`, or `all`)
- the expected `candidateCount` and a producer-declared `maxCandidates` ceiling
- the expected `source` and `trustLevel` for every JSONL line
- a `candidateIds` list matching the JSONL exactly

The accepted batch ID is persisted in `candidates.import_batch_id` and in the
`import_batches` ledger. The CLI exits non-zero and reports
`BATCH_ADMISSION_REJECTED`; the edge daemon records the refusal in its cycle
errors. The rejected spool file is left in place for remediation. Do not delete
it as a cleanup step.

Recovery:

1. Inspect the sidecar without editing the source file:
   `jq '.batchReceipt, (.candidateIds | length)' spool-*.jsonl.manifest.json`.
2. Compare the receipt count, ceiling, tenant, source, and trust stamp to the
   JSONL producer output. A changed JSONL file also fails the SHA-256 manifest
   check and is quarantined separately.
3. Regenerate the spool file from the producer with an explicit batch receipt,
   or preserve the rejected file for the legacy-corpus review in
   `bd_000-projects-gpg9.2`. Re-run `curator-cli ingest` only after the receipt
   and manifest are valid.

The decision record and evidence split are in
`000-docs/052-AT-DECR-reference-import-flood-2026-08-02.md`.
