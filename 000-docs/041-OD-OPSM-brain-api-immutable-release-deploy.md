# Runbook — immutable, versioned deploys for the governed brain API

| Field         | Value                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code**      | `041-OD-OPSM`                                                                                                                                 |
| **Type**      | Operations runbook                                                                                                                            |
| **Date**      | 2026-07-09                                                                                                                                    |
| **Service**   | `teamkb-brain-api.service` (systemd **--user**, on the tailnet team-server)                                                                   |
| **Bead**      | `compile-then-govern-jfv.6.6` (R6 / Gate-0 from the 6-engineer review)                                                                        |
| **Floor**     | tag **`v0.8.0`** @ `a2143be` — first tag containing E1 pre-hashed tokens                                                                      |
| **Companion** | `040-OD-OPSM` (the service, tokens, tailnet bind, client team-mode) — still valid; **§2 "after a code change" is superseded by this runbook** |

## Why this exists (the R6 problem)

Before R6 the live API ran **from Jeremy's mutable working checkout**:

```ini
WorkingDirectory=/home/jeremy/000-projects/qmd-team-intent-kb
ExecStart=/usr/bin/node apps/api/dist/main.js
```

That is unsafe for a live service:

1. Any `git checkout` / rebuild in that repo **mutates the running service's code**.
2. A crash-restart can relaunch from a **torn or feature-branch `dist/`**.
3. There is **no immutable rollback target** — the build that served Jun 25 – Jul 9 was overwritten
   in place. Worse, rolling the working checkout back **past the release floor `a2143be` (E1)**
   rebuilds the pre-E1 registry, which **double-hashes `~/.teamkb/tokens.json` and locks out all six
   users** (the registry would scrypt-hash the already-`scrypt$…` strings a second time).

The database is external (`~/.teamkb/teamkb.db`), so the fix is purely about the **code artifact**:
serve from an **immutable, tag-pinned release directory** behind an atomic `current` symlink.

## The layout

```
~/.local/opt/teamkb-api/
├── current -> releases/v0.8.0          # atomic pointer; the unit's WorkingDirectory
├── releases/
│   └── v0.8.0/                         # self-contained: source + node_modules + dist (no .git)
│       └── apps/api/dist/main.js       # what ExecStart runs (relative to WorkingDirectory)
└── DEPLOYS.log                         # append-only: <utc> tag= sha= actor= note=
```

Each `releases/<tag>` is produced by `git archive <tag>` (no `.git`, immutable) + `pnpm install
--frozen-lockfile` + `pnpm -r build`, built with **`/usr/bin/node`** so `better-sqlite3`'s native
ABI matches the node the unit runs. Releases are **never rebuilt in place** — a new tag is a new
directory, and rollback is a symlink flip.

## The release floor — the ONE rule

> **Never point `current` at a ref that does not contain `a2143be` (E1 pre-hashed tokens).**

The deploy script enforces this (`git merge-base --is-ancestor a2143be <tag>` → hard abort) and
re-checks it against the built artifact (`grep parseStoredHash …/dist/auth/token-registry.js`). The
tag **`v0.8.0`** is the floor: it is the first tag that contains E1. Deploying anything below it
double-hashes `~/.teamkb/tokens.json` and locks out every teammate.

## Deploy

```bash
cd ~/000-projects/qmd-team-intent-kb
scripts/deploy-brain-api.sh v0.8.0        # or any later tag that contains a2143be
```

What it does, in order (all `set -euo pipefail`, idempotent, safe):

1. `git fetch --tags` in the source repo.
2. **Floor check** — abort unless the tag contains `a2143be`.
3. **Build** a fresh `releases/<tag>` (archive → `pnpm install` → `pnpm -r build`). If the dir already
   exists and passes preflight, it is **reused** (re-running the same tag is a safe no-op re-point).
4. **Lockout preflight** — `grep parseStoredHash …/dist/auth/token-registry.js`, else abort.
5. **Smoke** — see below.
6. **Flip** `current -> releases/<tag>`, then `systemctl --user daemon-reload && restart`.
7. **Post-restart health gate** — if the new build is unhealthy it **auto-rolls back** the symlink,
   restarts, and exits non-zero (the service is never left down).
8. Append a line to `DEPLOYS.log` and **prune** to the newest 5 release dirs (never the live one).

### What the smoke proves (and what it can't)

Token records in `~/.teamkb/tokens.json` are **scrypt hashes** (E1). A hashed token can't be
exercised without its plaintext, which only the holder has. So the deploy smoke proves the **auth
gate and liveness**, not each token:

- `GET /api/health` → **200** (service up, DB opened) — `/api/health` is auth-exempt by design.
- unauthenticated `POST /api/search` → **401** (the bearer gate is on).
- the same two checks again **after** the restart, on the new build.

A real teammate's authed query returning `qmd://`-cited hits is the **final human confirmation** — do
one after cutover (see `040-OD-OPSM` §6).

## Rollback — seconds, no rebuild

Any prior `releases/<tag>` is a complete, ready-to-run build. To roll back:

```bash
ln -sfn releases/<prior-tag> ~/.local/opt/teamkb-api/current
systemctl --user daemon-reload
systemctl --user restart teamkb-brain-api.service
# smoke:
HOST=$(systemctl --user show teamkb-brain-api.service -p Environment --value | tr ' ' '\n' | sed -n 's/^TEAMKB_API_HOST=//p')
curl -s -o /dev/null -w 'health %{http_code}\n' "http://$HOST:3847/api/health"        # → 200
```

The deploy script does exactly this automatically if a post-restart smoke fails. **Constraint:** the
rollback target must still contain the floor `a2143be` — every retained release does, because the
floor guard blocks anything below it from ever becoming a release.

## ONE-TIME cutover (operator — do this once)

The release infra is **already staged** (`releases/v0.8.0` built + preflighted, `current` symlinked).
The only remaining change is to repoint the unit's `WorkingDirectory` at the `current` symlink — a
**one-line edit**; everything else in the unit (all `Environment=` lines, `ExecStart`, `Restart`,
`[Install]`) stays **byte-for-byte identical**. `ExecStart` remains `/usr/bin/node apps/api/dist/main.js`
because that path is relative to `WorkingDirectory`, which now resolves through `current`.

```bash
UNIT=~/.config/systemd/user/teamkb-brain-api.service

# 1. Back up the current unit
cp "$UNIT" "$UNIT.bak-$(date -u +%Y%m%d)"

# 2. Repoint WorkingDirectory (only this line changes)
#    from: WorkingDirectory=/home/jeremy/000-projects/qmd-team-intent-kb
#    to:   WorkingDirectory=/home/jeremy/.local/opt/teamkb-api/current
sed -i 's#^WorkingDirectory=.*#WorkingDirectory=/home/jeremy/.local/opt/teamkb-api/current#' "$UNIT"

# 3. Apply + verify
systemctl --user daemon-reload
systemctl --user restart teamkb-brain-api.service
systemctl --user show teamkb-brain-api.service -p WorkingDirectory   # → .../teamkb-api/current

# 4. Smoke
HOST=$(systemctl --user show teamkb-brain-api.service -p Environment --value | tr ' ' '\n' | sed -n 's/^TEAMKB_API_HOST=//p')
curl -s -o /dev/null -w 'health %{http_code}\n' "http://$HOST:3847/api/health"                                   # → 200
curl -s -o /dev/null -w 'unauth %{http_code}\n' -X POST "http://$HOST:3847/api/search" \
  -H 'content-type: application/json' -d '{"query":"x"}'                                                          # → 401
```

After this one-time edit, **all future deploys are `scripts/deploy-brain-api.sh <tag>`** — the working
checkout is never again the live service. To undo the cutover itself, restore the `.bak-…` unit,
`daemon-reload`, restart.

## Notes

- **Host / bind / tokens** are unchanged — see `040-OD-OPSM`. This runbook only changes _where the
  code artifact comes from_.
- **Disk:** each `releases/<tag>` is ~1 GB (full workspace `node_modules`, mostly pnpm-store
  hardlinks); the script keeps the newest 5.
- **Env overrides** (defaults shown): `TEAMKB_SRC_REPO=$HOME/000-projects/qmd-team-intent-kb`,
  `TEAMKB_API_OPT=$HOME/.local/opt/teamkb-api`, `TEAMKB_API_UNIT=teamkb-brain-api.service`,
  `TEAMKB_API_NODE=/usr/bin/node`, `TEAMKB_KEEP=5`, `TEAMKB_FLOOR_SHA=a2143be`.
