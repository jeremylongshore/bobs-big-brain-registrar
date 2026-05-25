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
# Stage 2 — get content into the workspace
#
# Two modes:
#   (a) ANTHROPIC_API_KEY set    → full pipeline: mount + ingest + Claude compile.
#                                  Produces REAL compiled wiki pages with
#                                  real frontmatter, real content-derived
#                                  category mappings. Slow (~minutes), costs
#                                  per-token Claude $.
#   (b) ANTHROPIC_API_KEY unset  → stub pipeline: copy corpus to raw/ and seed
#                                  one stub wiki page per source. Fast (~secs),
#                                  free. Demoes the pipeline shape; INTKB
#                                  ingests the same way. Not real compiled
#                                  knowledge.
#
# Per bead intentional-cognition-os-zcc.3 (closed 2026-05-24).
# ---------------------------------------------------------------------------

CORPUS_FILE_COUNT=$(find "$CORPUS" -type f \( -name "*.md" -o -name "*.markdown" \) | wc -l | tr -d ' ')

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  # -------------------------------------------------------------------------
  # Mode (a) — full Claude compile pipeline
  # -------------------------------------------------------------------------
  echo "[2/4] ANTHROPIC_API_KEY detected → running full Claude compile pipeline"
  echo ""
  # Cost expectation. The ICO compiler does 6 passes (summarise / extract /
  # synthesise / contradict / gap / link). Sonnet-4.6 is typically a few
  # cents per source for small docs; budget grows linearly with corpus.
  est_min_cents=$(( CORPUS_FILE_COUNT * 2 ))
  est_max_cents=$(( CORPUS_FILE_COUNT * 15 ))
  est_min_minutes=$(( (CORPUS_FILE_COUNT + 9) / 10 ))
  est_max_minutes=$(( CORPUS_FILE_COUNT / 2 + 1 ))
  echo "      Corpus has $CORPUS_FILE_COUNT markdown file(s)."
  echo "      Estimated cost (claude-sonnet-4-6, all 6 passes):"
  echo "        \$$(printf '%.2f' "$(awk "BEGIN{print $est_min_cents/100}")")"' – '"\$$(printf '%.2f' "$(awk "BEGIN{print $est_max_cents/100}")")"' (rough order-of-magnitude)'
  echo "      Estimated wall time: ${est_min_minutes}–${est_max_minutes} min"
  echo "      Press Ctrl-C now to cancel; otherwise compile starts in 5s..."
  sleep 5 || true
  echo ""
  echo "      → ico mount add corpus $CORPUS"
  cd "$WORKSPACE"
  node "$ICO_CLI" mount add corpus "$CORPUS" 2>&1 | tail -3
  echo ""
  echo "      → ico ingest <every file> (with --yes to skip per-file prompts)"
  i=0
  while IFS= read -r src; do
    i=$((i + 1))
    printf '      [%d/%d] ico ingest %s\n' "$i" "$CORPUS_FILE_COUNT" "$(basename "$src")"
    node "$ICO_CLI" ingest "$src" --yes >/dev/null 2>&1 \
      || echo "        (ingest failed for this file — continuing)"
  done < <(find "$CORPUS" -type f \( -name "*.md" -o -name "*.markdown" \))
  echo ""
  echo "      → ico compile all (this is the slow step — running all 6 passes)"
  if ! node "$ICO_CLI" compile all 2>&1 | tail -5; then
    echo "      compile non-zero exit — continuing with whatever shipped to wiki/"
  fi
  cd - >/dev/null
  compiled_count=$(find "$WORKSPACE/wiki" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  echo "      produced $compiled_count compiled wiki page(s) (real Claude output)"
else
  # -------------------------------------------------------------------------
  # Mode (b) — stub pipeline (no API key)
  # -------------------------------------------------------------------------
  echo "[2/4] No ANTHROPIC_API_KEY → stub pipeline (pipeline-shape demo only)"
  mkdir -p "$WORKSPACE/raw/corpus"
  # Copy markdown files (not symlinks — the operator's corpus must be
  # readable without further indirection from the workspace process).
  find "$CORPUS" -type f \( -name "*.md" -o -name "*.markdown" \) | while read -r f; do
    cp -n "$f" "$WORKSPACE/raw/corpus/" 2>/dev/null || true
  done
  count=$(find "$WORKSPACE/raw/corpus" -type f | wc -l | tr -d ' ')
  echo "      copied $count markdown file(s) to workspace raw/"

  # Seed at least one wiki page per source file so the pipeline shape is
  # demoable without a real Claude compile. Each stub gets the source
  # body's first 1KB and is marked model=stub.
  mkdir -p "$WORKSPACE/wiki/topics" "$WORKSPACE/wiki/concepts"
  stub_count=0
  find "$WORKSPACE/raw/corpus" -type f \( -name "*.md" -o -name "*.markdown" \) | head -10 | while read -r src; do
    fn="$(basename "$src" .md)"
    fn="${fn%.markdown}"
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
Set ANTHROPIC_API_KEY and re-run for the full ICO compile pipeline.*
EOF
    stub_count=$((stub_count + 1))
  done
  stub_count=$(find "$WORKSPACE/wiki/topics" -type f -name '*.md' | wc -l | tr -d ' ')
  echo "      seeded $stub_count stub wiki page(s) (no real Claude compile)"
fi

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
# Stage 4 — INTKB ingests from the same dir; write a curated/ dir for qmd
#
# The Stage-4 node script does two things:
#   (1) ingestFromSpool — puts candidates in CandidateRepository (in-memory)
#   (2) writes each candidate to $WORK/curated/<id>.md for stage 5 indexing
#
# QUICKSTART SHORTCUT: real production runs each candidate through the
# Curator's policy pipeline (apps/curator/src/curator.ts processBatch) which
# applies secret detection / dedup / tenant isolation, then promotes
# approved candidates to CuratedMemory via promote(). For the demo we
# write the ingested candidates straight to the curated/ dir so qmd has
# something to index without seeding a policy ruleset. The pipeline shape
# is honest; only the policy gate is short-circuited.
# ---------------------------------------------------------------------------
echo "[4/5] INTKB ingestFromSpool against $SHARED/spool"
CURATED_DIR="$WORK/curated"
mkdir -p "$CURATED_DIR"
node -e "
(async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
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
    // Write a markdown file per candidate for qmd to index.
    // QUICKSTART SHORTCUT: real production runs the Curator policy pipeline
    // first. Here we skip that gate so the demo has something for qmd to
    // index without seeding a tenant policy ruleset.
    const fm = [
      '---',
      'title: ' + JSON.stringify(cand.title),
      'category: ' + cand.category,
      'tenantId: ' + cand.tenantId,
      'source: ' + cand.source,
      'capturedAt: ' + cand.capturedAt,
      'id: ' + cand.id,
      '---',
      '',
      cand.content,
      '',
    ].join('\n');
    writeFileSync(join('$CURATED_DIR', cand.id + '.md'), fm, 'utf8');
  }
  console.log('      INTKB repo count:', repo.count());
  console.log('      curated/ dir:', '$CURATED_DIR', '(' + r.value.length + ' file(s))');
})();
"

# ---------------------------------------------------------------------------
# Stage 5 — qmd local-search index + sample query (the curated-answer loop)
#
# Per bead qmd-team-intent-kb-dmj.2. Completes the 035-AT-DECR §4.3 spec:
# 'a real outside operator-developer ... within 15 minutes [sees] (1) compiled
# wiki produced, (2) governance-promoted candidate memories visible via qmd
# search, (3) a sample query returning a curated answer with source attribution.'
# ---------------------------------------------------------------------------
echo ""
echo "[5/5] qmd local-search index + sample query"

if ! command -v qmd >/dev/null 2>&1; then
  cat <<'QMDHINT'
      ✗ qmd is not on PATH — skipping stage 5.

      qmd is the upstream local-search tool that this stack retrieves
      curated memory through. To install:
        - macOS / Linux:  curl -sSL https://qmd.sh/install.sh | bash
        - or via bun:     bun install -g @qmd-cli/qmd
      Then re-run this script.

      The pipeline above (ingestFromSpool) still ran; only the search
      demo is skipped.
QMDHINT
else
  COLLECTION_NAME="quickstart-demo-$$"
  echo "      qmd version: $(qmd --version 2>&1 | head -1)"
  # qmd's CLI signature: `collection add <PATH> --name <NAME>` (path first,
  # name is a flag — easy to get backwards).
  echo "      → qmd collection add $CURATED_DIR --name $COLLECTION_NAME"
  if ! qmd collection add "$CURATED_DIR" --name "$COLLECTION_NAME" 2>&1 | tail -3; then
    echo "      (collection add failed — see above; continuing)"
  fi
  echo "      → qmd update (index the new collection)"
  qmd update 2>&1 | tail -3 || true

  # Pick a query: use the first non-empty word from the first candidate's title.
  QUERY="$(find "$CURATED_DIR" -maxdepth 1 -type f -name '*.md' | head -1 | xargs -I {} awk -F': ' '/^title:/ {gsub(/[\"]/, "", $2); print $2; exit}' {} 2>/dev/null | awk '{print $1}')"
  QUERY="${QUERY:-quickstart}"
  echo ""
  echo "      → qmd search '$QUERY' (curated-answer query)"
  qmd search "$QUERY" 2>&1 | head -15 || echo "      (no results)"

  # Cleanup: remove the temp collection so it doesn't accumulate in qmd's state.
  echo ""
  echo "      → qmd collection remove $COLLECTION_NAME (cleanup)"
  qmd collection remove "$COLLECTION_NAME" 2>&1 | tail -2 || true
fi

echo ""
echo "================================================================"
echo "  DONE. Quickstart pipeline complete."
echo "  workspace:  $WORKSPACE"
echo "  spool dir:  $SHARED/spool"
echo "  curated/:   $CURATED_DIR"
echo "  cleanup:    rm -rf $WORK"
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
echo ""
echo "  Next: re-run with ANTHROPIC_API_KEY set to exercise the full"
echo "  ICO Claude compile pipeline (real wiki pages, not stubs)."
fi
echo "================================================================"
