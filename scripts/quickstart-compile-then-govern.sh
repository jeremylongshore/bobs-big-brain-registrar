#!/usr/bin/env bash
# quickstart-compile-then-govern.sh — single-command demo of the
# ICO → spool → INTKB pipeline against an operator-supplied corpus.
#
# Per 035-AT-DECR §4.3 (Build Item C). Goal: a new operator-developer can
# go from a directory of markdown notes to a curated-memory-ingested-by-
# INTKB end-state in under 15 minutes with one command.
#
# Today's deployment model: both ICO and INTKB are workspace-internal
# (not npm-published). This script assumes both repos are sibling checkouts
# under the same parent directory (the usual ~/000-projects/ layout).
#
# Usage:
#   bash scripts/quickstart-compile-then-govern.sh <corpus-dir> [--tenant <id>]
#
# Where <corpus-dir> is a directory of markdown notes. A workspace is
# created in a sibling temp dir; ICO compiles → emits to a shared spool;
# INTKB ingests; the candidate count is printed.
#
# Exit codes:
#   0  — pipeline succeeded
#   1  — operator input error (missing corpus, missing dep)
#   2  — pipeline step failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo "================================================================"
echo "  Compile, then govern — ICO + INTKB pipeline quickstart"
echo "================================================================"

CORPUS="${1:-}"
TENANT=""

if [[ -z "$CORPUS" ]]; then
  echo "usage: $0 <corpus-dir> [--tenant <id>]" >&2
  exit 1
fi
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant)
      TENANT="$2"
      shift 2
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$CORPUS" ]]; then
  echo "corpus directory not found: $CORPUS" >&2
  exit 1
fi
CORPUS="$(cd "$CORPUS" && pwd)"
TENANT="${TENANT:-$(basename "$CORPUS")}"

# ---------------------------------------------------------------------------
# Locate both checkouts (script lives in INTKB; ICO is a sibling)
# ---------------------------------------------------------------------------
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTKB_ROOT="$THIS_DIR"
ICO_ROOT="$(cd "$INTKB_ROOT/.." && pwd)/intentional-cognition-os"

if [[ ! -d "$ICO_ROOT" ]]; then
  echo "Cannot find intentional-cognition-os checkout at $ICO_ROOT" >&2
  echo "Set ICO_ROOT env var to override." >&2
  exit 1
fi
ICO_ROOT="${ICO_ROOT_OVERRIDE:-$ICO_ROOT}"

ICO_CLI="$ICO_ROOT/packages/cli/dist/index.js"
if [[ ! -f "$ICO_CLI" ]]; then
  echo "ICO CLI not built. Run: cd $ICO_ROOT && pnpm install && pnpm build" >&2
  exit 1
fi

INTKB_CURATOR_DIST="$INTKB_ROOT/apps/curator/dist/index.js"
INTKB_STORE_DIST="$INTKB_ROOT/packages/store/dist/index.js"
if [[ ! -f "$INTKB_CURATOR_DIST" || ! -f "$INTKB_STORE_DIST" ]]; then
  echo "INTKB curator + store not built. Run: cd $INTKB_ROOT && pnpm install && pnpm build" >&2
  exit 1
fi

echo "ICO root:     $ICO_ROOT"
echo "INTKB root:   $INTKB_ROOT"
echo "Corpus:       $CORPUS"
echo "Tenant:       $TENANT"
echo ""

# ---------------------------------------------------------------------------
# Stage 1 — temp workspace + shared spool dir
# ---------------------------------------------------------------------------
WORK="$(mktemp -d -t ico-quickstart-XXXXXX)"
SHARED="$WORK/shared"
WS_PARENT="$WORK/workspace"
mkdir -p "$SHARED/spool"
echo "[1/4] Creating temp workspace at $WS_PARENT"
node "$ICO_CLI" init quickstart --path "$WS_PARENT" >/dev/null
WORKSPACE="$WS_PARENT/quickstart"
echo "      ok"

# ---------------------------------------------------------------------------
# Stage 2 — copy / link corpus into the workspace's raw/ dir
# ---------------------------------------------------------------------------
echo "[2/4] Mounting corpus into workspace raw/"
mkdir -p "$WORKSPACE/raw/corpus"
# Copy markdown files (not symlinks — the operator's corpus must be readable
# without further indirection from the workspace process).
find "$CORPUS" -type f \( -name "*.md" -o -name "*.markdown" \) | while read -r f; do
  cp -n "$f" "$WORKSPACE/raw/corpus/" 2>/dev/null || true
done
count=$(find "$WORKSPACE/raw/corpus" -type f | wc -l | tr -d ' ')
echo "      copied $count markdown file(s) to workspace raw/"

# Seed at least one wiki page so the spool emit step has something concrete
# to emit even when the source corpus hasn't been Claude-compiled yet.
# (Real compile requires ANTHROPIC_API_KEY; the quickstart degrades gracefully
# to a "no compile, just demo the pipeline shape" mode if the key is absent.)
# Seed at least one wiki page per source file so the pipeline shape is
# demoable WITHOUT a real Claude compile (which requires ANTHROPIC_API_KEY
# + ico mount/ingest setup and would push the quickstart well past 15 min).
# To run the full compile pipeline, follow the post-demo instructions
# printed at the end of the script.
mkdir -p "$WORKSPACE/wiki/topics" "$WORKSPACE/wiki/concepts"
stub_count=0
find "$WORKSPACE/raw/corpus" -type f \( -name "*.md" -o -name "*.markdown" \) | head -10 | while read -r src; do
  fn="$(basename "$src" .md)"
  fn="${fn%.markdown}"
  # Slugify filename for the wiki target.
  slug="$(echo "$fn" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')"
  body="$(head -c 1024 "$src" || true)"
  cat > "$WORKSPACE/wiki/topics/$slug.md" <<EOF
---
type: topic
title: "Quickstart — $fn"
id: 00000000-0000-4000-8000-$(printf '%012d' $stub_count)
compiled_at: $(date -u +%Y-%m-%dT%H:%M:%S.000Z)
model: stub
---

$body

---
*Generated by quickstart-compile-then-govern.sh — no real Claude compile ran.
To run the full compile pipeline, set ANTHROPIC_API_KEY and use
\`ico mount add\` + \`ico ingest\` + \`ico compile all\` against the workspace.*
EOF
  stub_count=$((stub_count + 1))
done
stub_count=$(find "$WORKSPACE/wiki/topics" -type f -name '*.md' | wc -l | tr -d ' ')
echo "      seeded $stub_count stub wiki page(s) (pipeline-shape demo; no real Claude compile)"

# ---------------------------------------------------------------------------
# Stage 3 — ICO emits to the shared spool
# ---------------------------------------------------------------------------
echo "[3/4] ICO emits to shared spool: $SHARED/spool"
cd "$WORKSPACE"
TEAMKB_HOME="$SHARED" node "$ICO_CLI" spool emit --tenant "$TENANT" --out "$SHARED/spool"
cd - >/dev/null
spool_files=$(find "$SHARED/spool" -maxdepth 1 -type f -name 'spool-*.jsonl' | wc -l | tr -d ' ')
echo "      $spool_files spool file(s) written"

# ---------------------------------------------------------------------------
# Stage 4 — INTKB ingests from the same dir
# ---------------------------------------------------------------------------
echo "[4/4] INTKB ingestFromSpool against $SHARED/spool"
node -e "
(async () => {
  const c = await import('$INTKB_CURATOR_DIST');
  const store = await import('$INTKB_STORE_DIST');
  const db = store.createTestDatabase();
  const repo = new store.CandidateRepository(db);
  const r = await c.ingestFromSpool(repo, '$SHARED/spool');
  if (!r.ok) {
    console.error('ingest failed:', r.error);
    process.exit(2);
  }
  console.log('      ingested', r.value.length, 'candidate(s)');
  for (const cand of r.value) {
    console.log('       -', cand.id.slice(0,8) + '...', '['+cand.category+']', cand.title);
  }
  console.log('      INTKB repo count:', repo.count());
})();
"

echo ""
echo "================================================================"
echo "  DONE. Quickstart pipeline complete."
echo "  workspace:  $WORKSPACE"
echo "  spool dir:  $SHARED/spool"
echo "  cleanup:    rm -rf $WORK"
echo "================================================================"
