#!/usr/bin/env bash
# verify-policy-hash.sh — SHA-256 manifest for the INTKB governance ruleset.
#
# Sibling to .audit-harness/scripts/harness-hash.sh that pins the specific
# policy rule files that constitute the governance trust anchor. Per the
# CISO seat in 035-AT-DECR §2.5(2) + 036-AT-THRT, any unauthorised edit to
# the ruleset must REFUSE at pre-commit.
#
# This script is intentionally minimal — it doesn't extend the upstream
# @intentsolutions/audit-harness package; it mirrors the pattern for one
# repo-specific concern. If governance hash-pinning becomes common across
# repos, propose a PATTERNS entry upstream in the harness.
#
# Usage:
#   bash scripts/verify-policy-hash.sh --init     # write the manifest (engineer)
#   bash scripts/verify-policy-hash.sh --verify   # compare current vs manifest
#   bash scripts/verify-policy-hash.sh --list     # show which files are pinned
#
# Exit codes:
#   0 — OK (pin matches, or init succeeded)
#   2 — POLICY_TAMPERED (hash mismatch — refuse to commit)
#   3 — no manifest found (--verify without --init)

set -euo pipefail

ROOT="${ROOT:-$(pwd)}"
MANIFEST="${ROOT}/.policy-hash"

# Engineer-curated list of governance policy files. Edits here are governance-
# policy edits; require explicit engineer review + a fresh --init.
FILES=(
  "packages/policy-engine/src/rules/secret-detection-rule.ts"
  "packages/policy-engine/src/rules/dedup-check-rule.ts"
  "packages/policy-engine/src/rules/relevance-score-rule.ts"
  "packages/policy-engine/src/rules/content-length-rule.ts"
  "packages/policy-engine/src/rules/source-trust-rule.ts"
  "packages/policy-engine/src/rules/tenant-match-rule.ts"
  "packages/policy-engine/src/rules/sensitivity-gate-rule.ts"
  "packages/policy-engine/src/rules/content-sanitization-rule.ts"
  "packages/policy-engine/src/rules/contradiction-check-rule.ts"
  "packages/policy-engine/src/rules/index.ts"
  "packages/policy-engine/src/policy-engine.ts"
  # 5kw.1: the import exclusion gate is a structural deterministic reject
  # surface (brainignore) — same trust-anchor class as the policy rules, so
  # its ruleset + gate are pinned too.
  "apps/curator/src/import-exclusion/brainignore.ts"
  "apps/curator/src/import-exclusion/import-exclusion-gate.ts"
)

collect_present_files() {
  local out=()
  for f in "${FILES[@]}"; do
    if [[ -f "$ROOT/$f" ]]; then
      out+=("$f")
    fi
  done
  printf '%s\n' "${out[@]}"
}

compute_manifest() {
  local files
  files=$(collect_present_files)
  if [[ -z "$files" ]]; then
    echo "verify-policy-hash: no policy files found under \$ROOT — nothing to pin" >&2
    return 1
  fi
  while IFS= read -r f; do
    [[ -n "$f" ]] && sha256sum "$ROOT/$f" | awk -v p="$f" '{print $1, " ", p}'
  done <<<"$files"
}

cmd="${1:---help}"
case "$cmd" in
  --init)
    compute_manifest >"$MANIFEST"
    count=$(wc -l <"$MANIFEST")
    echo "policy-hash: pinned $count file(s) → $MANIFEST"
    ;;
  --verify)
    if [[ ! -f "$MANIFEST" ]]; then
      echo "policy-hash: no manifest at $MANIFEST — run --init first" >&2
      exit 3
    fi
    current=$(compute_manifest)
    if diff -u "$MANIFEST" <(printf '%s\n' "$current") >/dev/null 2>&1; then
      echo "policy-hash: OK"
    else
      echo "policy-hash: POLICY_TAMPERED — governance ruleset has changed without --init" >&2
      diff -u "$MANIFEST" <(printf '%s\n' "$current") >&2 || true
      exit 2
    fi
    ;;
  --list)
    if [[ -f "$MANIFEST" ]]; then
      cat "$MANIFEST"
    else
      echo "policy-hash: no manifest (run --init first)" >&2
    fi
    ;;
  --help|-h|*)
    echo "Usage: $0 [--init|--verify|--list]" >&2
    [[ "$cmd" == "--help" || "$cmd" == "-h" ]] && exit 0 || exit 1
    ;;
esac
