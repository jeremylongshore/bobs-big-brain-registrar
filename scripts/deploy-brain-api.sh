#!/usr/bin/env bash
#
# deploy-brain-api.sh — immutable, versioned deploy for the governed brain API.
#
# R6 / Gate-0 (6-engineer review). The live `teamkb-brain-api.service` must run
# from an IMMUTABLE, tag-pinned release directory — never from a mutable working
# checkout. This script deploys a git TAG into
#   $TEAMKB_API_OPT/releases/<tag>/          (self-contained: source + node_modules + dist)
# flips the atomic
#   $TEAMKB_API_OPT/current -> releases/<tag>
# symlink, and restarts the systemd --user unit whose WorkingDirectory is that
# `current` symlink. Rollback is a symlink flip back to any prior release + a
# restart (seconds, no rebuild).
#
# SAFETY CONTRACT
#   * Never deploys a ref that does not contain the release floor (E1 pre-hashed
#     tokens, default commit a2143be). A pre-E1 build double-hashes
#     ~/.teamkb/tokens.json and LOCKS OUT ALL USERS — so this is a hard abort.
#   * Never leaves the service down. If the post-restart smoke fails, it restores
#     the previous release, restarts, and exits non-zero.
#   * Never rebuilds a release dir that is already good — reuse is idempotent, so
#     re-running with the same tag is a safe no-op re-point + restart.
#
# The per-token smoke NOTE: token records in ~/.teamkb/tokens.json are scrypt
# hashes (E1). A hashed token cannot be exercised without the plaintext, which
# only its holder has. So the deploy smoke proves the AUTH GATE and LIVENESS, not
# each token: (1) GET /api/health -> 200 (service up, DB opened); (2) an
# unauthenticated POST /api/search -> 401 (the bearer gate is on); (3) the same
# two checks again after the restart on the new build. A real teammate's authed
# query is the final human confirmation (see the runbook).
#
# Usage:
#   scripts/deploy-brain-api.sh <tag>          # e.g. scripts/deploy-brain-api.sh v0.8.0
#
# Environment overrides (sane defaults; NO ~/.claude paths):
#   TEAMKB_SRC_REPO   git repo to fetch/archive from   (default: $HOME/000-projects/qmd-team-intent-kb)
#   TEAMKB_API_OPT    immutable release root           (default: $HOME/.local/opt/teamkb-api)
#   TEAMKB_API_UNIT   systemd --user unit name         (default: teamkb-brain-api.service)
#   TEAMKB_API_NODE   node binary; ABI must match unit (default: /usr/bin/node)
#   TEAMKB_KEEP       release dirs to retain on prune  (default: 5)
#   TEAMKB_FLOOR_SHA  floor commit that must be an      (default: a2143be)
#                     ancestor of the tag (E1)
#
set -euo pipefail

# --- config -----------------------------------------------------------------
SRC="${TEAMKB_SRC_REPO:-$HOME/000-projects/qmd-team-intent-kb}"
OPT="${TEAMKB_API_OPT:-$HOME/.local/opt/teamkb-api}"
UNIT="${TEAMKB_API_UNIT:-teamkb-brain-api.service}"
NODE="${TEAMKB_API_NODE:-/usr/bin/node}"
KEEP="${TEAMKB_KEEP:-5}"
FLOOR="${TEAMKB_FLOOR_SHA:-a2143be}"
RELEASES="$OPT/releases"

# --- state (used by the EXIT trap) ------------------------------------------
TAG=""
SHA=""
PREV=""
STAGING=""
OLD_ASIDE=""
FLIPPED=0
DEPLOY_OK=0

# --- helpers ----------------------------------------------------------------
log()  { printf '%s  [deploy] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

deploylog() {
  printf '%s  tag=%s  sha=%s  actor=%s  note=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${TAG:-?}" "${SHA:-?}" "${USER:-$(id -un)}" "$*" \
    >> "$OPT/DEPLOYS.log"
}

# Resolve the API base URL from the live unit's own Environment (no hardcoded IP).
api_base() {
  local envs host port
  envs="$(systemctl --user show "$UNIT" --property=Environment --value 2>/dev/null || true)"
  host="$(printf '%s' "$envs" | tr ' ' '\n' | sed -n 's/^TEAMKB_API_HOST=//p' | head -1)"
  port="$(printf '%s' "$envs" | tr ' ' '\n' | sed -n 's/^TEAMKB_API_PORT=//p' | head -1)"
  if [ -z "$host" ] && command -v tailscale >/dev/null 2>&1; then
    host="$(tailscale ip -4 2>/dev/null | head -1)"
  fi
  [ -n "$port" ] || port="3847"
  [ -n "$host" ] || return 1
  printf 'http://%s:%s' "$host" "$port"
}

# Poll GET /api/health until 200 (service up) or timeout.
health_ok() {
  local base code
  base="$(api_base)" || { log "cannot resolve API endpoint for health check"; return 1; }
  for _ in $(seq 1 20); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$base/api/health" 2>/dev/null || echo 000)"
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  return 1
}

# Full smoke: health 200 AND unauthenticated POST /api/search 401 (auth gate on).
smoke_check() {
  local base code
  base="$(api_base)" || { log "smoke: cannot resolve API endpoint"; return 1; }
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$base/api/health" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] || { log "smoke: health expected 200, got $code ($base/api/health)"; return 1; }
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
          -X POST "$base/api/search" -H 'content-type: application/json' \
          -d '{"query":"deploy-smoke"}' 2>/dev/null || echo 000)"
  [ "$code" = "401" ] || { log "smoke: unauth POST /api/search expected 401, got $code (AUTH GATE OFF?!)"; return 1; }
  log "smoke OK: health 200, unauth /api/search 401 ($base)"
  return 0
}

# Lockout preflight: the built token-registry MUST accept pre-hashed scrypt tokens.
lockout_preflight() {
  local dir="$1"
  grep -q parseStoredHash "$dir/apps/api/dist/auth/token-registry.js" 2>/dev/null \
    || die "LOCKOUT PREFLIGHT FAILED: parseStoredHash absent in $dir — a pre-E1 build would double-hash ~/.teamkb/tokens.json and lock out ALL users. Refusing to deploy."
}

rollback() {
  log "rolling back the current symlink"
  if [ -n "$PREV" ]; then
    ln -sfn "$PREV" "$OPT/current" || true
    log "current -> $PREV (restored)"
  else
    log "no previous release recorded — cannot restore symlink; restarting current as-is"
  fi
  systemctl --user daemon-reload || true
  systemctl --user restart "$UNIT" || true
  if health_ok; then
    log "rollback restart is healthy"
  else
    log "WARN: service still UNHEALTHY after rollback — MANUAL INTERVENTION NEEDED (journalctl --user -u $UNIT -n 80)"
  fi
  deploylog "ROLLBACK to ${PREV:-none} (post-restart smoke failed)"
}

cleanup_on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$FLIPPED" = 1 ] && [ "$DEPLOY_OK" != 1 ]; then
    log "deploy failed after symlink flip (rc=$rc)"
    rollback
  fi
  if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then rm -rf "$STAGING"; fi
  exit "$rc"
}
trap cleanup_on_exit EXIT

# Reuse a good release dir, else build a fresh one via `git archive` (self-contained).
build_release() {
  local dir="$RELEASES/$TAG"
  if [ -d "$dir" ] && [ -f "$dir/apps/api/dist/main.js" ] \
     && grep -q parseStoredHash "$dir/apps/api/dist/auth/token-registry.js" 2>/dev/null; then
    log "release $TAG already built and passes preflight — reusing (idempotent)"
    return 0
  fi
  command -v pnpm >/dev/null 2>&1 || die "pnpm not found on PATH"
  [ -x "$NODE" ] || die "node binary not executable: $NODE"
  log "building release $TAG from $SRC @ $SHA (node: $NODE)"
  mkdir -p "$RELEASES"
  STAGING="$(mktemp -d "$RELEASES/.stage-XXXXXX")"
  git -C "$SRC" archive "$TAG" | tar -x -C "$STAGING"
  (
    cd "$STAGING"
    nodebin_dir="$(dirname "$NODE")"
    export PATH="$nodebin_dir:$PATH"         # pin the node whose ABI the unit uses
    export HUSKY=0                           # no .git in an archive extract
    pnpm install --frozen-lockfile
    pnpm -r build
  )
  [ -f "$STAGING/apps/api/dist/main.js" ] || die "build produced no apps/api/dist/main.js"
  lockout_preflight "$STAGING"
  if [ -e "$dir" ]; then
    OLD_ASIDE="$dir.old.$$"
    mv "$dir" "$OLD_ASIDE"       # only reached for a broken existing dir (never the live target)
  fi
  mv "$STAGING" "$dir"
  STAGING=""
  log "release built: $dir"
}

# Keep the newest $KEEP release dirs; never remove the live target or the just-deployed one.
prune_releases() {
  local curtarget name n=0 d
  curtarget="$(readlink "$OPT/current" 2>/dev/null || true)"
  curtarget="${curtarget#releases/}"
  # newest-first by mtime; tag dirs never contain spaces/newlines
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in .*) continue ;; esac      # skip staging dirs
    n=$((n + 1))
    [ "$n" -le "$KEEP" ] && continue
    [ "$name" = "$curtarget" ] && continue
    [ "$name" = "$TAG" ] && continue
    log "pruning old release: $name"
    rm -rf "$d"
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -not -name '.*' -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2-)
}

# --- main -------------------------------------------------------------------
[ $# -eq 1 ] || die "usage: $(basename "$0") <tag>   (e.g. v0.8.0)"
TAG="$1"
[ -d "$SRC/.git" ] || die "source repo not found: $SRC (set TEAMKB_SRC_REPO)"

log "fetching tags from origin"
git -C "$SRC" fetch --tags --force origin >/dev/null 2>&1 || die "git fetch failed in $SRC"

SHA="$(git -C "$SRC" rev-list -n1 "$TAG" 2>/dev/null || true)"
[ -n "$SHA" ] || die "tag not found: $TAG"

log "verifying release floor ($FLOOR) is an ancestor of $TAG ($SHA)"
git -C "$SRC" merge-base --is-ancestor "$FLOOR" "$TAG" \
  || die "REFUSING: $TAG does not contain the release floor $FLOOR (E1 pre-hashed tokens). Deploying it would double-hash tokens.json and lock out all users."

build_release
lockout_preflight "$RELEASES/$TAG"

# Pre-flip smoke against the currently-live service (informational — we still
# deploy even if the old build is already unhealthy; the hard gate is post-restart).
if smoke_check; then log "pre-flip: live service healthy"; else log "pre-flip: live service NOT fully healthy (continuing — post-restart smoke is the gate)"; fi

PREV="$(readlink "$OPT/current" 2>/dev/null || true)"
log "flipping current: ${PREV:-<none>} -> releases/$TAG"
ln -sfn "releases/$TAG" "$OPT/current"
FLIPPED=1

log "daemon-reload + restart $UNIT"
systemctl --user daemon-reload
systemctl --user restart "$UNIT"

log "waiting for post-restart health"
health_ok || die "post-restart health check failed (service did not return 200 on /api/health)"
smoke_check || die "post-restart smoke failed"

# Success — service confirmed healthy on the new build.
DEPLOY_OK=1
deploylog "DEPLOYED (current -> releases/$TAG)"
log "deploy OK: $UNIT now running releases/$TAG (sha $SHA)"

prune_releases
if [ -n "$OLD_ASIDE" ] && [ -d "$OLD_ASIDE" ]; then rm -rf "$OLD_ASIDE"; fi

log "done."
