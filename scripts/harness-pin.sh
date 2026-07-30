#!/usr/bin/env bash
# scripts/harness-pin.sh — SHA-256 manifest of engineer-owned policy artifacts.
#
# Pins every file whose bytes encode a POLICY decision (thresholds,
# classifications, requirement MoSCoW tags, persona declarations, journey
# step inventory, architecture rules). Any byte change to a pinned file
# without a fresh `--init` is HARNESS_TAMPERED and `--verify` exits 2.
#
# ## Why a repo-local script
#
# The upstream `@intentsolutions/audit-harness` ships
# `node_modules/@intentsolutions/audit-harness/scripts/harness-hash.sh` with
# a hardcoded PATTERNS array that misses this repo's policy files
# (tests/TESTING.md, RTM, PERSONAS, JOURNEYS, stryker.config.mjs,
# vitest.config.ts, scripts/crap-score.ts). This script encodes the right
# pattern list for THIS repo — tracked in qmd-team-intent-kb-tpp.
#
# STATUS 2026-07-22 — the upstream limitation this forked around is FIXED.
# audit-harness v1.3.0's `harness-hash.sh` reads an optional
# `.harness-hash-extra-patterns` file at the repo root and appends its lines to
# the default PATTERNS array, which is exactly the configurability this comment
# said did not exist. Of the 8 files pinned here, only `.dependency-cruiser.cjs`
# is an upstream default; the other 7 would move into that file.
#
# Retiring this fork is therefore now POSSIBLE but is deliberately NOT bundled
# into the cleanup that removed the dead vendored copy. It changes the gate that
# guards every policy artifact in the repo, and the two scripts' `.harness-hash`
# manifest formats have not been proven byte-compatible — a mismatch means a
# forced re-init, and re-initialising a tamper manifest is itself a policy event
# that has to be reviewed, not a side effect of a tidy-up. Do it as its own
# change, with the pinned-set equivalence demonstrated before and after.
#
# ## Usage
#
#   bash scripts/harness-pin.sh --init      # write .harness-hash (engineer-initiated)
#   bash scripts/harness-pin.sh --verify    # compare current to manifest
#   bash scripts/harness-pin.sh --list      # show which files are pinned
#
# ## Exit codes
#
#   0 — OK (verify passed, or init succeeded)
#   2 — HARNESS_TAMPERED (hash mismatch on verify)
#   3 — no manifest found (--verify without --init)
#   4 — usage error

set -euo pipefail

ROOT="${ROOT:-$(pwd)}"
MANIFEST="${MANIFEST:-$ROOT/.harness-hash}"

# Policy artifacts engineered by humans, enforced by the AI escape-scan.
# Adding/removing entries here is itself a policy change — review carefully.
PATTERNS=(
  # L7 acceptance policy (engineer-owned per audit-tests skill spec)
  "tests/TESTING.md"
  "tests/RTM.md"
  "tests/PERSONAS.md"
  "tests/JOURNEYS.md"

  # Architecture rules (Wall 7)
  ".dependency-cruiser.cjs"

  # Mutation-testing thresholds (Wall 6)
  "stryker.config.mjs"

  # Coverage thresholds (Wall 3) — coverage block in vitest config
  "vitest.config.ts"

  # CRAP-score threshold (Wall 5)
  "scripts/crap-score.ts"
)

collect_files() {
  local out=()
  shopt -s nullglob globstar
  for pattern in "${PATTERNS[@]}"; do
    for f in $pattern; do
      [[ -f "$f" ]] && out+=("$f")
    done
  done
  printf '%s\n' "${out[@]}" | sort -u
}

hash_files() {
  local files
  files=$(collect_files)
  if [[ -z "$files" ]]; then
    return 0
  fi
  while IFS= read -r f; do
    printf '%s  %s\n' "$(sha256sum "$f" | awk '{print $1}')" "$f"
  done <<< "$files"
}

cmd_init() {
  cd "$ROOT"
  hash_files > "$MANIFEST"
  local count
  count=$(wc -l < "$MANIFEST" | tr -d ' ')
  echo "harness-pin: pinned $count file(s) → $MANIFEST"
}

cmd_verify() {
  cd "$ROOT"
  if [[ ! -f "$MANIFEST" ]]; then
    echo "harness-pin: no manifest at $MANIFEST (run --init)" >&2
    exit 3
  fi
  local current expected diff_out
  current=$(hash_files)
  expected=$(cat "$MANIFEST")

  diff_out=$(diff <(echo "$expected" | sort) <(echo "$current" | sort) || true)
  if [[ -z "$diff_out" ]]; then
    echo "harness-pin: OK"
    exit 0
  fi
  echo "HARNESS_TAMPERED: pinned policy artifact changed without engineer-initiated re-pin" >&2
  echo "" >&2
  echo "Diff (expected vs current):" >&2
  echo "$diff_out" >&2
  echo "" >&2
  echo "If this change is intentional, re-pin with:" >&2
  echo "  bash scripts/harness-pin.sh --init" >&2
  echo "and commit the updated .harness-hash alongside the policy change." >&2
  exit 2
}

cmd_list() {
  cd "$ROOT"
  if [[ ! -f "$MANIFEST" ]]; then
    echo "harness-pin: no manifest (run --init)" >&2
    exit 3
  fi
  awk '{print $2}' "$MANIFEST"
}

case "${1:-}" in
  --init)   cmd_init ;;
  --verify) cmd_verify ;;
  --list)   cmd_list ;;
  --help|-h)
    sed -n '2,30p' "$0"
    exit 0
    ;;
  *)
    echo "Usage: $0 {--init|--verify|--list|--help}" >&2
    exit 4
    ;;
esac
