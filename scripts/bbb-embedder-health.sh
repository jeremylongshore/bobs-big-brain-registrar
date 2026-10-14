#!/usr/bin/env bash
# bbb-embedder-health.sh — page when the dense-retrieval embedder is not actually working.
#
# WHY (bead compile-then-govern-39z.15, found 2026-10-02)
# bbb-embedder crash-looped because its pinned model file had been deleted from
# ~/.cache/qmd/models. Every reindex then reported `dense serviceDown:true` and failed OPEN to
# lexical-only search, so semantic Recall@10 silently fell from ~0.96 to ~0.34 with nobody paged.
# Dense is the production default, so "embedder down" is a quality outage, not a cosmetic one.
#
# WHAT IT CHECKS (every run; each failure is a distinct, plain-English line)
#   1. the pinned weights file exists and is non-trivially sized (cache cleanup removes it)
#   2. the systemd user unit is active
#   3. GET /health answers ok
#   4. a REAL embedding round-trip returns a finite vector of the expected dimension (768)
#      — a service that is "up" but returns garbage/empty is the same outage
# Once a day it also verifies the weights SHA-256 against the pin (cheap insurance, ~2 s).
#
# BEHAVIOR
#   exit 0  → silent (audit line in history.log only); if the last run was down, one recovery page
#   exit 1  → arm_fail_trap fires cron_fail → Buzz sys-automation (severity high) with the log tail
#   It does NOT restart the service: a crash-looping unit hammering a missing weight file is
#   worse than a page. systemd's Restart=always covers clean exits; a human (or the runbook,
#   registrar 000-docs/051-AT-RNBK) fixes anything else.
#
# REPEAT PAGES (bead compile-then-govern-39z.25, outage 2026-10-10..13)
# The alert floor suppresses an exact repeat of a delivered message FOREVER. This check used to
# send the same words on every failure, so the 2026-10-10 outage paged Buzz once at 21:00 on a
# Saturday and the next 196 failures were dropped as duplicates; a later outage with the same
# symptoms would not have paged at all. The last log line now carries when this outage started
# and a 6-hour reminder count, so each outage pages once at the start and again every 6 hours
# while it lasts.
#
# USAGE
#   bbb-embedder-health.sh               # normal run (arms the failure trap)
#   bbb-embedder-health.sh --check-only  # print the verdict + exit code, never alert (testing)
# Env overrides (testing): BBB_EMB_URL, BBB_EMB_WEIGHTS, BBB_EMB_UNIT, BBB_EMB_DIMS
set -uo pipefail
export PATH="$HOME/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"

URL="${BBB_EMB_URL:-http://127.0.0.1:8098}"
WEIGHTS="${BBB_EMB_WEIGHTS:-$HOME/.cache/qmd/models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf}"
PIN="$HOME/.local/lib/bbb/embedder-weights.sha256"
UNIT="${BBB_EMB_UNIT:-bbb-embedder}"
DIMS="${BBB_EMB_DIMS:-768}"
MIN_BYTES=$((250 * 1024 * 1024))   # the Q8_0 file is ~318 MB; anything under 250 MB is truncated

STATE_DIR="$HOME/.local/state/bbb-embedder-health"
LOG="$STATE_DIR/last-run.log"
HISTORY="$STATE_DIR/history.log"
DOWN_SINCE="$STATE_DIR/down-since"   # epoch seconds of the first failed run of the current outage
REPAGE_SECS="${BBB_EMB_REPAGE_SECS:-21600}"
mkdir -p "$STATE_DIR"

CHECK_ONLY=0
[ "${1:-}" = "--check-only" ] && CHECK_ONLY=1

problems=()
note() { problems+=("$1"); }

# 1. weights present and not truncated
if [ ! -f "$WEIGHTS" ]; then
  note "model weights file is MISSING: $WEIGHTS (cache cleanup removes it; restore the verified copy: cp ~/.local/lib/bbb/weights-backup/$(basename "$WEIGHTS") $WEIGHTS, then sha256sum -c $PIN; or re-download per registrar 000-docs/051-AT-RNBK)"
else
  size=$(stat -c %s "$WEIGHTS" 2>/dev/null || echo 0)
  [ "$size" -ge "$MIN_BYTES" ] || note "model weights file looks truncated ($size bytes, expected >= $MIN_BYTES): $WEIGHTS"
  # 1b. once a day, the full pin check
  stamp="$STATE_DIR/sha-checked.$(date -u +%F)"
  if [ ! -f "$stamp" ] && [ -f "$PIN" ]; then
    if sha256sum -c "$PIN" >/dev/null 2>&1; then
      rm -f "$STATE_DIR"/sha-checked.* 2>/dev/null; touch "$stamp"
    else
      note "model weights SHA-256 does NOT match the pin in $PIN (corrupt or wrong file; never bypass the gate)"
    fi
  fi
fi

# 2. unit active
state=$(systemctl --user is-active "$UNIT" 2>/dev/null || true)
[ "$state" = "active" ] || note "systemd user unit $UNIT is '${state:-unknown}', not active"

# 3. /health
health=$(curl -s -m 5 "$URL/health" 2>/dev/null || true)
case "$health" in *'"ok"'*) : ;; *) note "embedder $URL/health did not answer ok (got: ${health:-no response})" ;; esac

# 4. functional round-trip
# Generous timeout on purpose: under a busy-box load spike a trivial embed can take ~40 s (measured
# 2026-10-04 at load 36). Slow-but-valid is a WARNING in the log, not a page; only "no valid answer
# within 90 s" counts as down.
t0=$(date +%s)
resp=$(curl -s -m 90 -H 'Content-Type: application/json' -d '{"input":"embedder health probe"}' "$URL/v1/embeddings" 2>/dev/null || true)
probe_secs=$(( $(date +%s) - t0 ))
verdict=$(printf '%s' "$resp" | python3 -c '
import sys, json, math
try:
    v = json.load(sys.stdin)["data"][0]["embedding"]
    dims = '"$DIMS"'
    if len(v) != dims: print("wrong dimension %d (expected %d)" % (len(v), dims))
    elif not all(isinstance(x, (int, float)) and math.isfinite(x) for x in v): print("non-finite values in vector")
    elif max(abs(x) for x in v) == 0: print("all-zero vector")
    else: print("ok")
except Exception as e:
    print("no valid embedding returned (%s)" % type(e).__name__)
' 2>/dev/null)
[ "$verdict" = "ok" ] || note "embedding round-trip failed: ${verdict:-no output}"

now=$(date +%s)
since=$(cat "$DOWN_SINCE" 2>/dev/null || true)
case "$since" in ''|*[!0-9]*) since=$now ;; esac

{
  echo "=== bbb-embedder-health $(date -u +%FT%TZ) ==="
  if [ ${#problems[@]} -eq 0 ]; then
    echo "OK: weights present, unit active, /health ok, embedding round-trip returned $DIMS finite dims in ${probe_secs}s"
    [ "$probe_secs" -le 15 ] || echo "WARN: embed probe took ${probe_secs}s (box under load?); queries embed per search, so interactive search will feel slow"
  else
    echo "DENSE RETRIEVAL IS DOWN OR DEGRADED — search is failing open to lexical-only (semantic recall drops ~0.96 -> ~0.34)."
    for p in "${problems[@]}"; do echo "  - $p"; done
    echo "Runbook: registrar 000-docs/051-AT-RNBK-embedder-service-and-dense-index-runbook.md"
    # Last line on purpose: cron_fail sends the log tail, and this line makes each outage and each
    # 6-hour reminder a different message (see REPEAT PAGES above).
    echo "Down since $(date -u -d "@$since" +%FT%TZ) ($(( (now - since) / 3600 ))h); reminder $(( (now - since) / REPAGE_SECS ))."
  fi
} > "$LOG" 2>&1

rc=0; [ ${#problems[@]} -eq 0 ] || rc=1
echo "$(date -u +%FT%TZ) rc=$rc problems=${#problems[@]}" >> "$HISTORY"

if [ "$CHECK_ONLY" -eq 1 ]; then cat "$LOG"; exit "$rc"; fi

source "$HOME/bin/lib/intent-runtime.sh"
if [ "$rc" -eq 0 ]; then
  if [ -f "$DOWN_SINCE" ]; then
    rm -f "$DOWN_SINCE"
    buzz_post "bbb-embedder-health: dense retrieval is back (down since $(date -u -d "@$since" +%FT%TZ), $(( (now - since) / 60 )) min)." sys-automation high
  fi
else
  [ -f "$DOWN_SINCE" ] || echo "$since" > "$DOWN_SINCE"
fi
arm_fail_trap "bbb-embedder-health" "$LOG"
exit "$rc"
