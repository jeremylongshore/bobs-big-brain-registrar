#!/usr/bin/env bash
# bbb-reindex-heal.sh — fail-loud search-health self-heal for both BBB tenants.
#
# The qmd index is derived state. This wrapper is safe to run after a compile or
# from a user systemd timer: it probes known-positive controls, reindexes once
# when the probe is unhealthy, and exits non-zero if the final probe is still
# unhealthy. notify-lib owns the two-marker liveness contract and failure page.
set -euo pipefail
umask 077

export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${HOME}/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

NOTIFY_LIB="${BBB_NOTIFY_LIB:-$HOME/bin/lib/notify-lib.sh}"
if [[ ! -r "$NOTIFY_LIB" ]]; then
  echo "bbb-reindex-heal: notify-lib is missing or unreadable: $NOTIFY_LIB" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$NOTIFY_LIB"
arm_fail_trap "bbb-reindex-heal" ""

REGISTRAR_ROOT="${BBB_REGISTRAR_ROOT:-$HOME/000-projects/bobs-big-brain-registrar}"
CLI="${BBB_REINDEX_CLI:-$REGISTRAR_ROOT/packages/qmd-adapter/dist/cli.js}"
NODE_BIN="${BBB_NODE_BIN:-$(command -v node || true)}"
BASE="${TEAMKB_BASE_PATH:-$HOME/.teamkb}"
MAX_STALENESS="${BBB_REINDEX_MAX_STALENESS_SECONDS:-86400}"
EXPECTED_QMD_VERSION="${BBB_QMD_EXPECTED_VERSION:-2.5.3}"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "bbb-reindex-heal: node is not executable: ${NODE_BIN:-<not found>}" >&2
  exit 1
fi
if [[ ! -r "$CLI" ]]; then
  echo "bbb-reindex-heal: qmd adapter CLI is missing: $CLI" >&2
  echo "bbb-reindex-heal: build Registrar first (pnpm --filter @qmd-team-intent-kb/qmd-adapter... build)" >&2
  exit 1
fi
if [[ ! -d "$BASE/kb-export" ]]; then
  echo "bbb-reindex-heal: export tree is missing: $BASE/kb-export" >&2
  exit 1
fi
if [[ ! "$MAX_STALENESS" =~ ^[0-9]+$ ]]; then
  echo "bbb-reindex-heal: BBB_REINDEX_MAX_STALENESS_SECONDS must be a non-negative integer" >&2
  exit 1
fi

# Prefer the pinned qmd shipped by Registrar. The CLI itself delegates to qmd;
# allowing an older personal PATH binary here would recreate the tenant/index
# split this guard exists to catch. A version mismatch is an infrastructure
# failure, not a reason to run a best-effort heal with an unknown binary.
QMD_BIN=""
if [[ -n "${BBB_QMD_BIN:-}" ]]; then
  QMD_BIN="$BBB_QMD_BIN"
elif [[ -x "$REGISTRAR_ROOT/node_modules/.bin/qmd" ]]; then
  QMD_BIN="$REGISTRAR_ROOT/node_modules/.bin/qmd"
elif command -v qmd >/dev/null 2>&1; then
  QMD_BIN="$(command -v qmd)"
fi
if [[ -z "$QMD_BIN" || ! -x "$QMD_BIN" ]]; then
  echo "bbb-reindex-heal: qmd binary not found (expected $EXPECTED_QMD_VERSION)" >&2
  exit 1
fi
QMD_VERSION="$("$QMD_BIN" --version 2>/dev/null | sed -nE 's/^qmd ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n1)"
if [[ "$QMD_VERSION" != "$EXPECTED_QMD_VERSION" ]]; then
  echo "bbb-reindex-heal: qmd version mismatch: expected $EXPECTED_QMD_VERSION, got ${QMD_VERSION:-unknown} ($QMD_BIN)" >&2
  exit 1
fi
QMD_DIR="$(dirname "$QMD_BIN")"
export PATH="$QMD_DIR:$PATH"

read -r -a TENANTS <<< "${BBB_REINDEX_TENANTS:-intent-solutions local}"
if [[ "${#TENANTS[@]}" -eq 0 ]]; then
  echo "bbb-reindex-heal: BBB_REINDEX_TENANTS resolved to an empty tenant list" >&2
  exit 1
fi

for tenant in "${TENANTS[@]}"; do
  [[ -n "$tenant" ]] || { echo "bbb-reindex-heal: empty tenant id" >&2; exit 1; }
  echo "bbb-reindex-heal: canary --heal tenant=$tenant base=$BASE max_staleness=${MAX_STALENESS}s"
  TEAMKB_BASE_PATH="$BASE" TEAMKB_TENANT_ID="$tenant" \
    "$NODE_BIN" "$CLI" canary --heal --max-staleness-seconds "$MAX_STALENESS"
done

echo "bbb-reindex-heal: all tenants healthy (${TENANTS[*]})"
