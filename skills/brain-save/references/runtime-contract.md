# Registrar Brain Save runtime contract

## Contents

- [Required runtime](#required-runtime)
- [Tool contracts](#tool-contracts)
- [Mixed-mode boundary](#mixed-mode-boundary)
- [Security and known limitation](#security-and-known-limitation)

## Required runtime

The repository's shipped `intent-brain` marketplace runtime exposes only `teamkb_search`. Brain Save
requires the source-built `apps/mcp-server` with `TEAMKB_ROLE=admin`. `TEAMKB_TENANT_ID` is required;
`TEAMKB_BASE_PATH` selects the local spool, SQLite database, feedback, and export directories.

## Tool contracts

- `teamkb_search`: required `query`; optional `scope` and `limit`.
- `teamkb_propose`: required `title` and `content`; optional `category` and `filePaths`. Success returns
  a candidate UUID after a local spool write.
- `teamkb_status`: no input. Returns local database counts, recent feedback, and `dbPath`.
- `teamkb_transition`: required UUID `memoryId`, lifecycle `to`, non-empty `reason`, and non-empty
  `actor`; optional UUID `supersededBy`, required when `to` is `superseded`. Success returns old/new
  states and an audit-event UUID.

`teamkb_status` reads curated database state and feedback. It does not inspect the spool, so it cannot
confirm a proposal is governed or even visible to the curator yet.

## Mixed-mode boundary

With `TEAMKB_API_URL` set, `teamkb_search` queries the remote API, but propose, status, and transition
still use local paths. This can create a split-brain operator workflow. Leave the API URL unset unless
that split is intentional and clearly disclosed.

`TEAMKB_ROLE=admin` controls which local tools register. It is a client-side capability gate, not an
authentication credential. Protect the local base directory through operating-system permissions.

## Security and known limitation

`teamkb_propose` writes a proposal, not a promoted memory. A separate curator applies secret checks,
deduplication, policy, and promotion.

For `active` to `superseded`, `supersededBy` must identify a distinct active curated memory in the
same tenant. The lifecycle, `SupersessionLink` (replacement UUID, reason and time) and superseded audit
event commit together, or all roll back. The replacement stays active. This does not create graph
edges or rebuild a search index. The batch-transition CLI still refuses supersession because it has
no per-memory replacement mapping. These contracts address `qmd-team-intent-kb-ehi`; deployments need
the corresponding Registrar source build, not an older bundled runtime.
