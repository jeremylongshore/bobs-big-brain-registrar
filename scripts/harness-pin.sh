#!/usr/bin/env bash
# Compatibility entrypoint for the installed stock audit-harness verifier.
# The stock defaults plus .harness-hash-extra-patterns define one protected set
# for both pnpm harness-pin and pnpm exec audit-harness verify. Verification
# never provisions dependencies or initializes a missing manifest.
set -euo pipefail

usage_error() {
  echo 'harness-pin: use --verify [--json], --init, --list, or --help' >&2
  exit 4
}
case "${1:-}" in
  --verify)
    [[ "$#" -eq 1 || ( "$#" -eq 2 && "${2:-}" == '--json' ) ]] || usage_error
    ;;
  --init|--list|--help|-h)
    [[ "$#" -eq 1 ]] || usage_error
    ;;
  *) usage_error ;;
esac

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
pin_root="${ROOT:-$(pwd)}"
canonical_manifest="$pin_root/.harness-hash"
if [[ -n "${MANIFEST:-}" && "$MANIFEST" != "$canonical_manifest" ]]; then
  echo 'harness-pin: alternate MANIFEST is unsupported; use ROOT for an isolated checkout' >&2
  exit 4
fi
verifier="$repo_root/node_modules/@intentsolutions/audit-harness/scripts/harness-hash.sh"
if [[ ! -f "$verifier" ]]; then
  echo 'harness-pin: installed audit-harness verifier missing; install the frozen dependencies first' >&2
  exit 3
fi
exec bash "$verifier" "$@"
