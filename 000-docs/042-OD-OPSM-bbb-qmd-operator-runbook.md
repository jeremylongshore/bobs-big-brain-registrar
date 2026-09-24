# 042-OD-OPSM — Bob's Big Brain + Tobi qmd operator runbook

**Status:** Active  
**Date:** 2026-07-14  
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

## Scheduled reindex and self-heal

The qmd index is derived state. A successful compile is not enough to prove
that promoted memories are searchable, so the Registrar ships
`bin/bbb-reindex-heal.sh`. It runs the known-positive canary with `--heal` for
both `intent-solutions` and `local`, using the pinned workspace qmd binary when
available and requiring qmd `2.5.3`. It exits non-zero if either tenant is still unhealthy after one
reindex attempt; `notify-lib` turns that failure into a `bbb-reindex-heal`
failure page and maintains the `.beat`/`.ok` liveness markers.

Install the wrapper to `~/bin` from a reviewed Registrar checkout and ensure
the adapter has been built:

```bash
install -m 0755 bin/bbb-reindex-heal.sh ~/bin/bbb-reindex-heal.sh
pnpm --filter @qmd-team-intent-kb/qmd-adapter... build
TEAMKB_BASE_PATH="$HOME/.teamkb" ~/bin/bbb-reindex-heal.sh
```

The user timer templates are `scripts/systemd/bbb-reindex-heal.{service,timer}`.
Mission Control owns installation and enablement after the compile window; the
timer must run from the same user that owns `~/.teamkb` and `~/bin`.

Useful overrides for a disposable fixture or a controlled drill:

```bash
BBB_REGISTRAR_ROOT=/path/to/bobs-big-brain-registrar \
BBB_REINDEX_TENANTS='intent-solutions local' \
BBB_REINDEX_MAX_STALENESS_SECONDS=86400 \
~/bin/bbb-reindex-heal.sh
```

Verification is outcome-based: each tenant must report all six known-positive
controls healthy after the optional heal. A zero exit from the surrounding
compile job does not bypass this check.

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
