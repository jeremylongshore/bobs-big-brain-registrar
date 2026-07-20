#!/usr/bin/env bash
# ots-stamp-anchor.sh — OPT-IN OpenTimestamps receipt for the latest audit
# anchor hash (GSB Wave-2, Track F4).
#
# What this does
#   stamp   Read the LAST record of the anchor log (default
#           ~/.teamkb/audit/anchors.jsonl), extract its `anchorHash`, write
#           that hash into a small per-anchor artifact file next to the log
#           (ots/<anchorHash>.anchor), and `ots stamp` it — producing
#           ots/<anchorHash>.anchor.ots, a Bitcoin-calendar timestamp proof.
#   upgrade Re-contact the calendar servers to upgrade a PENDING proof to a
#           complete Bitcoin attestation (typically ready hours after stamp).
#   verify  Verify a proof against its artifact file.
#
# Why: the anchor log makes chain rewrites tamper-EVIDENT locally, but a local
# writer can still rewrite log + chain together. An OTS receipt binds a given
# anchorHash to Bitcoin-anchored wall-clock time held by INDEPENDENT calendar
# servers — a rewrite after the stamp cannot back-date itself past the receipt.
#
# Honesty box — what this does and does NOT give you:
#   - `ots stamp` needs NETWORK access to public calendar servers. The
#     attestation returned immediately is PENDING; the Bitcoin block
#     confirmation typically completes in a few hours, after which
#     `ots upgrade` embeds the final proof.
#   - `ots verify` is NOT zero-network either: upgrading/checking pending
#     proofs contacts calendar servers, and verifying a completed Bitcoin
#     attestation needs a local Bitcoin node (bitcoind) — without one, `ots
#     verify` reports the attested block height/time but cannot independently
#     confirm it; you can cross-check the block hash against a public
#     explorer, which trusts that explorer.
#   - This is a TIMESTAMP, not a signature: it proves the hash existed by a
#     point in time, not who wrote it (that is the signed merge anchor's job).
#   - Deliberately NOT wired into any blocking gate — stamping is a manual /
#     cron opt-in, and a calendar outage must never stall governance.
#
# Setup (one-time, isolated venv — never a global pip install):
#   python3 -m venv ~/.local/lib/bbb/ots-venv
#   ~/.local/lib/bbb/ots-venv/bin/pip install opentimestamps-client
#
# Usage:
#   scripts/ots-stamp-anchor.sh stamp   [anchor-log-path]
#   scripts/ots-stamp-anchor.sh upgrade [anchor-log-path]   # upgrade newest proof
#   scripts/ots-stamp-anchor.sh verify  [anchor-log-path]   # verify newest proof
#
# Artifacts live next to the anchor log:  <log-dir>/ots/<anchorHash>.anchor{,.ots}

set -euo pipefail

OTS_BIN="${OTS_BIN:-$HOME/.local/lib/bbb/ots-venv/bin/ots}"
ANCHOR_LOG_DEFAULT="$HOME/.teamkb/audit/anchors.jsonl"

CMD="${1:-}"
ANCHOR_LOG="${2:-$ANCHOR_LOG_DEFAULT}"

usage() { sed -n 's/^# \?//p' "$0" | sed -n '1,48p' >&2; }

if [ -z "$CMD" ] || { [ "$CMD" != "stamp" ] && [ "$CMD" != "upgrade" ] && [ "$CMD" != "verify" ]; }; then
  usage
  exit 2
fi

if [ ! -x "$OTS_BIN" ]; then
  echo "ots-stamp-anchor: ots client not found at $OTS_BIN" >&2
  echo "  install: python3 -m venv ~/.local/lib/bbb/ots-venv && ~/.local/lib/bbb/ots-venv/bin/pip install opentimestamps-client" >&2
  exit 2
fi

if [ ! -f "$ANCHOR_LOG" ]; then
  echo "ots-stamp-anchor: no anchor log at $ANCHOR_LOG" >&2
  exit 2
fi

OTS_DIR="$(dirname "$ANCHOR_LOG")/ots"
mkdir -p "$OTS_DIR"

# Latest anchorHash from the last non-empty JSONL line. Works for both the
# unsigned anchor log (schemaVersion 1) and the signed merge-anchor log
# (schemaVersion 2) — both carry a trailing `anchorHash` field.
latest_hash() {
  tail -n 20 "$ANCHOR_LOG" | grep -v '^[[:space:]]*$' | tail -n 1 \
    | sed -nE 's/.*"anchorHash":"([0-9a-f]{64})".*/\1/p'
}

HASH="$(latest_hash)"
if [ -z "$HASH" ]; then
  echo "ots-stamp-anchor: could not extract anchorHash from the last line of $ANCHOR_LOG" >&2
  exit 1
fi

ARTIFACT="$OTS_DIR/$HASH.anchor"
PROOF="$ARTIFACT.ots"

case "$CMD" in
  stamp)
    if [ -f "$PROOF" ]; then
      echo "already stamped: $PROOF (use 'upgrade' to complete a pending attestation)"
      exit 0
    fi
    # The artifact is the stamped subject: the anchor hash plus minimal
    # provenance, so the .ots proof is self-describing on disk.
    {
      printf 'anchorHash=%s\n' "$HASH"
      printf 'anchorLog=%s\n' "$ANCHOR_LOG"
      printf 'stampedAt=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } > "$ARTIFACT"
    echo "stamping anchor head $HASH via OpenTimestamps calendar servers (network required)..."
    "$OTS_BIN" stamp "$ARTIFACT"
    echo "wrote proof: $PROOF"
    echo "NOTE: the attestation is PENDING — Bitcoin confirmation takes hours;"
    echo "      run '$0 upgrade' later to embed the completed proof."
    ;;
  upgrade)
    if [ ! -f "$PROOF" ]; then
      echo "ots-stamp-anchor: no proof for the current head ($PROOF) — run 'stamp' first" >&2
      exit 1
    fi
    "$OTS_BIN" upgrade "$PROOF" || true
    "$OTS_BIN" info "$PROOF"
    ;;
  verify)
    if [ ! -f "$PROOF" ]; then
      echo "ots-stamp-anchor: no proof for the current head ($PROOF) — run 'stamp' first" >&2
      exit 1
    fi
    # See the honesty box: full independent verification of a completed
    # attestation needs a local bitcoind; without one this reports the
    # attested calendar/block info.
    "$OTS_BIN" verify "$PROOF" || true
    "$OTS_BIN" info "$PROOF"
    ;;
esac
