#!/usr/bin/env bash
#
# install-llama-server.sh — install the SHA-256-pinned llama.cpp release that
# serves the Bob's Big Brain reranker (blueprint bead B1, decision 044-AT-DECR).
#
# The reranker runtime is a stock llama.cpp `llama-server` release binary run as
# a loopback-only systemd user service (`bbb-reranker.service`). Like the GGUF
# weights (packages/qmd-adapter/src/weights/weights-manifest.ts), the runtime
# binary is pinned by SHA-256 and verified fail-closed BEFORE install: a
# govern-by-receipts product does not run an unverified inference runtime.
#
# Pin provenance: tag + asset chosen from the ggml-org/llama.cpp GitHub release
# that was latest at build time (2026-07-19); the hash below was computed from
# the asset downloaded on the dev box that day. To bump: pick a new release,
# download the ubuntu x64 asset, `sha256sum` it, update the three PIN_ values,
# re-run. Old versions stay on disk; `current` flips atomically.
#
# Install layout:
#   ~/.local/lib/bbb/llama-server/<tag>/   — the release contents (llama-server + libs)
#   ~/.local/lib/bbb/llama-server/current  — symlink to the active <tag>
#
# Idempotent: a re-run with the pinned tag already installed verifies the
# installed binary responds and exits 0 without re-downloading.

set -euo pipefail

PIN_TAG="b10068"
PIN_ASSET="llama-b10068-bin-ubuntu-x64.tar.gz"
PIN_SHA256="6bf3d20de562e4df230f1a7c54fb7a06a80c7ff40f5311c953e8255744be4eb2"

BASE_DIR="${HOME}/.local/lib/bbb/llama-server"
DEST_DIR="${BASE_DIR}/${PIN_TAG}"
CURRENT_LINK="${BASE_DIR}/current"
URL="https://github.com/ggml-org/llama.cpp/releases/download/${PIN_TAG}/${PIN_ASSET}"

log() { printf '[install-llama-server] %s\n' "$*"; }
die() { printf '[install-llama-server] ERROR: %s\n' "$*" >&2; exit 1; }

# Idempotency: already installed + binary answers --version → done.
if [[ -x "${DEST_DIR}/llama-server" ]]; then
  if "${DEST_DIR}/llama-server" --version >/dev/null 2>&1; then
    ln -sfn "${DEST_DIR}" "${CURRENT_LINK}"
    log "already installed: ${DEST_DIR} (current -> ${PIN_TAG}); nothing to do"
    exit 0
  fi
  log "existing install at ${DEST_DIR} is broken; reinstalling"
  rm -rf "${DEST_DIR}"
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

log "downloading ${PIN_ASSET} (${PIN_TAG})"
curl -fsSL --retry 3 -o "${WORK_DIR}/${PIN_ASSET}" "${URL}"

# Fail-closed integrity gate: the downloaded asset MUST match the pinned hash.
ACTUAL_SHA256="$(sha256sum "${WORK_DIR}/${PIN_ASSET}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${PIN_SHA256}" ]]; then
  die "SHA-256 mismatch for ${PIN_ASSET}: expected ${PIN_SHA256}, got ${ACTUAL_SHA256}. Refusing to install an unverified runtime."
fi
log "sha256 verified: ${ACTUAL_SHA256}"

tar -xzf "${WORK_DIR}/${PIN_ASSET}" -C "${WORK_DIR}"
# Release tarballs extract to a llama-<tag>/ directory containing llama-server + its shared libs.
EXTRACTED_DIR="${WORK_DIR}/llama-${PIN_TAG}"
[[ -x "${EXTRACTED_DIR}/llama-server" ]] || die "extracted archive has no executable llama-server at ${EXTRACTED_DIR}"

mkdir -p "${BASE_DIR}"
rm -rf "${DEST_DIR}.tmp"
mv "${EXTRACTED_DIR}" "${DEST_DIR}.tmp"
mv -T "${DEST_DIR}.tmp" "${DEST_DIR}"
ln -sfn "${DEST_DIR}" "${CURRENT_LINK}"

"${CURRENT_LINK}/llama-server" --version >/dev/null 2>&1 || die "installed llama-server does not run"
log "installed ${PIN_TAG} -> ${DEST_DIR}; current -> ${PIN_TAG}"
# Capture (not pipe) the version line: llama-server keeps writing after `head`
# would close the pipe, and SIGPIPE + pipefail would fail an otherwise-good install.
VERSION_LINE="$("${CURRENT_LINK}/llama-server" --version 2>&1 | sed -n 1p)"
log "${VERSION_LINE}"
