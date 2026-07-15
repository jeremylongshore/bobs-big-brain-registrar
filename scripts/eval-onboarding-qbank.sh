#!/usr/bin/env bash
# eval-onboarding-qbank.sh — score day-1 outsider probes via bbb-qmd (Tobi qmd + team XDG).
# Exit 0 if total score >= 80% of max (19/24); exit 1 otherwise.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BBB="${ROOT}/scripts/bbb-qmd"
if [[ ! -x "$BBB" ]]; then
  echo "missing bbb-qmd" >&2
  exit 2
fi

# label|probe
PROBES=(
  "Q1 product|Intent Solutions product"
  "Q2 VPS|Contabo VPS intentsolutions"
  "Q3 brain stack|compile then govern qmd"
  "Q4 beads|beads bd tracking"
  "Q5 secrets|SOPS age secrets"
  "Q6 PR standard|Outsider Test commit PR"
  "Q7 testing|audit-harness testing SOP"
  "Q8 GCP|GCP Contabo VPS"
  "Q9 how use brain|Bob Big Brain bbb-qmd"
  "Q10 personal vs team|XDG teamkb qmd-index"
  "Q11 bd-sync Plane|bd-sync Plane"
  "Q12 day one|onboarding day"
)

total=0
max=$(( ${#PROBES[@]} * 2 ))
echo "=== Onboarding Q-bank (bbb-qmd keyword probes) ==="
for entry in "${PROBES[@]}"; do
  label="${entry%%|*}"
  q="${entry#*|}"
  n="$("$BBB" search --json -- "$q" 2>/dev/null | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  print(len(d) if isinstance(d,list) else 0)
except Exception:
  print(0)')"
  if [[ "$n" -ge 3 ]]; then s=2
  elif [[ "$n" -ge 1 ]]; then s=1
  else s=0
  fi
  total=$((total + s))
  echo "$s  hits=$n  $label  | $q"
done
pct=$(( total * 100 / max ))
echo "TOTAL $total / $max (${pct}%)"
threshold=$(( max * 80 / 100 ))
if [[ "$total" -ge "$threshold" ]]; then
  echo "PASS (>= 80%)"
  exit 0
fi
echo "FAIL (< 80%)" >&2
exit 1
