# Runbook — the governed brain API on the tailnet team-server

| Field       | Value                                                             |
| ----------- | ----------------------------------------------------------------- |
| **Code**    | `040-OD-OPSM`                                                     |
| **Type**    | Operations runbook                                                |
| **Date**    | 2026-06-21                                                        |
| **Service** | `teamkb-brain-api.service` (systemd **--user**)                   |
| **Bead**    | `compile-then-govern-650.5` (deploy, closed) · hardening: `650.6` |

The deployed, tailnet-only query surface of the governed brain (`apps/api`). This is the **D27
single remote brain**: one token-authenticated host that the team reaches over Tailscale. It runs
on the **team-server (the dev box)** for the soak — **not the VPS** (D27, D17 blast radius) — and
migrates to a dedicated tailnet VM once load-bearing (`650.6`).

## 1. What runs, and where

- **Host:** the dev box, on the tailnet as `team-server` / `dev` (`tailscale ip -4`).
- **Bind:** the tailnet IP only, port **3847** (`TEAMKB_API_HOST=<tailnet-ip>`) — never `0.0.0.0`,
  never public. Reachable only by tailnet peers.
- **Brain:** `~/.teamkb/teamkb.db` (tenant `intent-solutions`), qmd export `~/.teamkb/kb-export`.
- **Auth:** every route requires `Authorization: Bearer <token>`; no token → `401`.

## 2. The service

systemd **user** unit (persists across logout/reboot because `loginctl enable-linger jeremy` is on
and the unit is `WantedBy=default.target`). It is ordered after `tailscaled` so it binds the tailnet
IP only once the interface is up.

```ini
# ~/.config/systemd/user/teamkb-brain-api.service  (abridged)
[Unit]
After=network-online.target tailscaled.service
[Service]
WorkingDirectory=/home/jeremy/000-projects/qmd-team-intent-kb
ExecStart=/usr/bin/node apps/api/dist/main.js
Environment=TEAMKB_API_HOST=<tailnet-ip>   TEAMKB_API_PORT=3847
Environment=TEAMKB_DB_PATH=/home/jeremy/.teamkb/teamkb.db
Environment=TEAMKB_TENANT_ID=intent-solutions
Environment=TEAMKB_EXPORT_DIR=/home/jeremy/.teamkb/kb-export
Environment=TEAMKB_TOKENS_FILE=/home/jeremy/.teamkb/tokens.json
Environment=NODE_ENV=production
Restart=on-failure
[Install]
WantedBy=default.target
```

After a code change: `pnpm -F @qmd-team-intent-kb/api build` then restart (below). The unit runs the
built `apps/api/dist/main.js`, not `tsx`.

## 3. Operate it

```bash
systemctl --user status  teamkb-brain-api.service     # state
systemctl --user restart teamkb-brain-api.service     # apply a rebuild / token change
systemctl --user stop    teamkb-brain-api.service     # take it down
journalctl --user -u teamkb-brain-api.service -n 50 --no-pager   # logs (JSON lines)
```

## 4. Tokens (add / rotate a teammate)

Tokens live in `~/.teamkb/tokens.json` (mode 600) — a JSON array of records:

```json
[
  { "actor": "jeremy", "role": "admin", "tenants": null, "expiresAt": null },
  { "actor": "ope", "role": "member", "tenants": null, "expiresAt": null }
]
```

Each record's `token` field is the bearer secret. The registry accepts **either** a plaintext
secret (hashed with scrypt on load) **or** a pre-hashed `scrypt$<salt>$<hash>` form
(`hashToken()` in `apps/api/src/auth/token-registry.ts`). To add a teammate:

1. Generate a random secret (e.g. `openssl rand -hex 24`).
2. Add a record. **Prefer the pre-hashed form** — `node -e 'import("./apps/api/dist/auth/token-registry.js").then(m=>console.log(m.hashToken(process.argv[1])))' <secret>` — so no plaintext bearer token rests on disk (see §7).
3. `systemctl --user restart teamkb-brain-api.service`.
4. Hand the **plaintext** secret to the teammate over a secure channel — never in chat, commits, or
   this repo. `role: member` = read + propose; `admin` = promote/govern. `tenants: ["intent-os"]`
   scopes a token to one tenant; `null` = all.

## 5. Clients — team mode

The unified `governed-second-brain` plugin auto-selects **team mode** when `TEAMKB_API_URL` is set
(otherwise it runs the local in-process brain). A teammate points it at this server:

```bash
TEAMKB_API_URL=http://<tailnet-ip>:3847
TEAMKB_API_TOKEN=<their bearer secret>
```

Team mode exposes the unified `brain_search` (read); capture/govern stay governed server-side.

## 6. Verify

```bash
# no token → 401 (gate is on)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://<tailnet-ip>:3847/api/search \
  -H 'content-type: application/json' -d '{"query":"x"}'        # → 401

# with a token → cited hits from the brain
curl -s -H "Authorization: Bearer <secret>" -X POST http://<tailnet-ip>:3847/api/search \
  -H 'content-type: application/json' \
  -d '{"query":"system map","pagination":{"page":1,"pageSize":3}}'   # → {"hits":[{"citation":"qmd://...
```

Verified 2026-06-21 against a same-artifact ephemeral instance: authed `/api/search` returns
`qmd://`-cited hits, and the unified plugin in team mode proxies to the API and returns the same
cited shape. (Functional path proven without mutating the live service; a real teammate's authed
query is the final confirmation.)

## 7. Known gaps / follow-ons (`compile-then-govern-650.6`)

- **Tokens are stored plaintext on disk** today (`tokens.json` records are not `scrypt$`-prefixed).
  The plaintext bearer secrets sit in `~/.teamkb/tokens.json` and any backup of `~/.teamkb`.
  Re-seed with `hashToken()` output (§4) or SOPS-encrypt the file.
- **No token expiry/rotation** (`expiresAt: null`); the registry supports it — set one.
- **Liveness probe:** `/api/health` is **already exempt from auth** (`apps/api/src/middleware/api-key-auth.ts`
  — `/api/health`, `/openapi.json`, `/docs*` are always public), so a tailnet uptime probe hits it
  anonymously; every other route still requires the bearer token. (Not a gap — point probes at `/api/health`.)
- **Soak host:** runs on the dev box (which also runs Claude sessions + has OOM history); migrate to
  a dedicated tailnet VM once load-bearing (D27).

## 8. References

- D27 (single remote brain, not the VPS): `intent-os decision-log/004-…`.
- The unified plugin (local | team): `governed-second-brain-plugin`; decision `intent-os/000-docs/014-AT-DECR-…`.
- The dogfood proof: `intent-os/000-docs/015-AA-AACR-…`.

## Health diagnostic privacy and consumer migration

At the source revision implementing `compile-then-govern-zgh`, anonymous
`GET /api/health` returns only `status`, `uptime`, `dbConnected` and `version`.
It no longer scans or returns tenant policy dormancy or global index freshness.
The existing deploy script checks the HTTP status only and keeps using this
liveness route; existing 200/503 behavior is preserved.

Global diagnostics move to `GET /api/health/diagnostics`, requiring a valid
**unscoped admin** bearer token. Members and tenant-scoped admins cannot read
this global aggregation, including when naming an allowed tenant. This route
does not offer a tenant-filtered view; do not broaden a monitoring token's
tenant scope to work around a refusal. Existing loopback development no-auth
mode retains its existing global administrative standing.

Any diagnostic monitor reading `policyDormancy` or `indexStalenessSeconds`
from the prior public response must migrate explicitly to the protected route
and use existing approved global administrative credentials. Those fields
are absent from public liveness; absence is not an empty/healthy diagnostic
result. Repository consumers were inspected: the deploy script uses status
only, and the optional promote/search integration fixture now reads the
protected diagnostic route. External monitoring consumers and deployed
versions remain unverified; this source change does not migrate their
credentials, alter ACLs, or deploy a service. Before rollout, inventory those
consumers and verify effective network exposure through the authorized
operational gate.

Rolling back source restores the prior anonymous diagnostic exposure. Do not
use rollback as a credential or network recovery procedure. No persisted
brain data or schema migration is involved.
