# Governed Redaction & Audience Narrowing Runbook

**Document:** 054-OD-RNBK-governed-redaction-and-audience-narrowing
**Date:** 2026-10-04
**Status:** Active
**Scope:** the `curator-cli narrow-audience` and `curator-cli redact` subcommands, the
`audience_narrowing` policy rule, `POST /api/memories/:id/narrow-audience` (Epic K bead K3,
expanded scope), and the derived-index scrub `qmd-index scrub-index` (umbrella bead
`compile-then-govern-39z.19`, section 4.7).
**Decision record:** [`053-AT-DECR`](053-AT-DECR-claim-level-audience-governance-k1.md).

---

## 1. Two operations, two different promises

| Operation     | What changes                 | What does not change                 | Receipt action      |
| ------------- | ---------------------------- | ------------------------------------ | ------------------- |
| **Narrowing** | who may read the memory      | its content, its hash, its existence | `audience_narrowed` |
| **Redaction** | the content, and so its hash | its id, its lifecycle, its receipts  | `redacted`          |

Narrowing is for a claim that is fine to keep but is shown to too many people. Redaction is for
text that must not be in the store at all, such as a password. Archiving does neither: an archived
memory is hidden from default search and its text is still in the database.

Both are deterministic, both are human-initiated, and both write a hash-chained receipt in the same
transaction as the change. No model decides either one.

## 2. Narrowing

### 2.1 What it does

Moves a promoted memory to a strictly narrower audience tier: `tenant` → `admins` → `owner`.
Skipping a tier is allowed. Widening, an equal tier, and an unknown tier are refused. Widening is a
separate governed path (bead K4) and is not available.

The receipt records the actor, the time, the reason, and `{ from, to }`.

### 2.2 CLI

```bash
# One memory (full id, or a unique prefix of at least 8 hex characters)
node apps/curator/dist/main.js narrow-audience \
  --db <path> --tenant <id> --to admins \
  --actor <you> --reason "<why>" --memory-id <id|prefix> --dry-run

# Many memories: one UUID per line, '#' comments allowed
node apps/curator/dist/main.js narrow-audience \
  --db <path> --tenant <id> --to owner \
  --actor <you> --reason "<why>" --ids-file ids.txt
```

`--dry-run` opens the store read-only and writes nothing. `--json` emits one JSON envelope. Each
memory is narrowed in its own transaction with its own receipt, so a run that stops halfway leaves
every completed narrowing fully receipted.

Exit codes: `0` every target narrowed · `3` at least one refusal · `2` usage error · `1` I/O failure.

The report also shows, per memory, the tier the `audience_narrowing` rule recommends for the
content. That is advice. The command applies the tier you asked for.

### 2.3 API

`POST /api/memories/:id/narrow-audience` with body `{ "to": "admins", "reason": "..." }`. Admin
tokens only. The receipt's actor is the authenticated caller, not a body field. A caller cannot
narrow a memory they cannot read: another tenant's memory, or one above their read standing, answers
`404`. Refusals answer `400` with a `code` (`widening`, `same`, `unknown_to`, `missing_reason`).

### 2.4 After narrowing

The exported Markdown file and the search index still hold the memory until the exporter runs in
reconcile mode. Reconcile removes the file of a memory that is no longer tenant-wide; then reindex.

## 3. The `audience_narrowing` policy rule

A new `PolicyRuleType`, added the way `contradiction_check` was: a schema enum member and an
evaluator, no store migration.

- It flags a candidate whose declared audience is wider than its content calls for: credential-shaped
  content recommends `owner`, PII-shaped content recommends `admins`.
- It returns `pass` or `flag`, never `fail`, so no policy action can turn it into a rejection.
- It recommends. It never writes an audience.
- The reason names pattern ids only, never the matched text.

**It is dormant on an existing store until the policy is upgraded.** The pipeline only runs rules a
policy names. `RECOMMENDED_POLICY_RULES` now includes it, so a store whose policy predates this
change reports it as a dormant rule until an operator runs `curator-cli upgrade-policy --tenant <id>
--db <path>` (preview with `--dry-run`). Because the curator treats a flagged candidate as not
promoted, expect the rule to hold back the same candidates `sensitivity_gate` already flags, plus a
reason that says which tier to use.

**Its own measurement (KR8.2).** The rule is measured against a hand-labeled fixture of 29 cases,
`packages/policy-engine/src/__tests__/fixtures/audience-narrowing-labeled.ts`, and its numbers are
reported separately from the secret and PII disclosure metrics:

| Cases | TP  | FP  | FN  | TN  | Precision | Recall |
| ----- | --- | --- | --- | --- | --------- | ------ |
| 29    | 13  | 3   | 1   | 12  | 0.81      | 0.93   |

The four wrong answers are labeled in the fixture and are limits of the underlying patterns:
compensation stated in words is missed; a ten-digit build number, a 40-character commit hash and a
documentation placeholder connection string are false alarms.

## 4. Redaction

### 4.1 What it does

1. Replaces the content of the `curated_memories` row.
2. Replaces the content of every `candidates` row that holds a copy: the row the memory was promoted
   from, and any other row in the tenant with the same content hash.
3. Recomputes the content hash on each rewritten row.
4. Appends one `redacted` receipt per rewritten row.

Steps 1 to 4 are one transaction. Then, outside the transaction, the command rebuilds the FTS5
index, truncates the write-ahead log, runs `VACUUM`, truncates the log again, and byte-scans the
database, `-wal` and `-shm` files for the removed text. Last, it scrubs every tenant's derived
search index and byte-scans those files with the same removed text (section 4.7). The report says
what each step did.

### 4.2 What the receipt holds

Actor, time, reason, mode, the **old** and **new** content hashes, the **names** of the secret
patterns that fired on the old text, and the ids of the candidate copies. It never holds the removed
text. Command output, JSON, and error messages follow the same rule.

### 4.3 Why the audit chain still verifies

`verifyAuditChain` hashes `audit_events` rows only. A redaction rewrites content in other tables and
appends new audit rows; it does not edit, re-hash or remove an existing one. Every earlier receipt
is byte-identical after a redaction, the known historical forks are untouched, and the `redacted`
receipt chains forward from the current head.

### 4.4 Three ways to say what to remove

| Flag                                        | Use it when                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `--replacement-text` / `--replacement-file` | you want to replace the whole content                                                  |
| `--lines 12,20-22`                          | you know which lines hold the secret; each becomes `[REDACTED]`                        |
| `--scan`                                    | the deterministic secret scan recognizes the secret; it becomes `[REDACTED:<pattern>]` |

Every mode ends the same way: the result is re-scanned, and the redaction is **refused** if a secret
pattern still fires or the result fails the disclosure gate. Scan mode is also refused when the scan
finds nothing, because a scan miss is not evidence that the memory is clean. The scan is
`scanTextForSecrets`, the same function the `secret_detection` rule and `curator-cli secret-sweep`
use, so it recognizes a password stated in prose only when the value is quoted or backticked.

A dry-run reports which patterns fired on the current content and on which line numbers (numbers
only), which is how to choose `--lines`. `--replacement-title`
replaces the title as well.

### 4.5 Exit codes

`0` redacted, would redact, or already redacted · `3` refused · `4` redacted and receipted, but the
physical scrub or the index scrub is incomplete · `2` usage error · `1` I/O failure.

Exit `4` means another process held the store or an index while the scrub ran, or the index scrub
could not finish (section 4.7 lists why: a busy index, an unexpected qmd schema, a refused mass
removal, removed text still in an index file, or the scrub tool not found). The redaction is committed and
its receipts are on the chain, so the chain verifies the same on the exit `0` and exit `4` paths;
only the removal of the old bytes from the files is unfinished. Stop the other process and run the
same command again: it reports `unchanged`, writes no new receipt, and retries the scrub.

`--skip-scrub` skips the FTS rebuild, the WAL truncate, `VACUUM` and the byte scan. The redaction is
still committed and receipted and the command exits `0`, but **the old text is still in the database
files** and nothing has checked otherwise. Use it only to defer the scrub to a quiet window, and
finish by running the same command again without the flag. A redaction is not done until a run
reports `Physical scrub: complete` and `Index scrub: complete for this memory`, and a standalone
`qmd-index scrub-index` after the exporter reconcile and reindex reports `Index scrub: complete`.
The redact-time verdict covers the redacted memory's rows only: a fragment that another memory
still exports is reported there, not counted as a failure.

`--skip-index-scrub` skips only the derived-index scrub. Use it when you are about to delete and
rebuild the indexes anyway; the indexes keep the old text until you do. `--index-dir` and
`--export-dir` default to `qmd-index/` and `kb-export/` beside the `--db` file, which is the
`~/.teamkb` layout.

### 4.6 Procedure

Stop the processes that hold the store or the indexes open (the brain API service, Claude Code
sessions using the brain MCP server, any running govern, compile or reindex job) so the scrubs are
not blocked, and confirm there is free disk for `VACUUM` (up to the size of the largest database).

```bash
# 1. Preview. Read-only. --show-title prints the title so you can confirm the target.
node apps/curator/dist/main.js redact \
  --db <path> --tenant <id> --memory-id <id|prefix> \
  --actor <you> --reason "<why, without quoting the secret>" \
  --replacement-text "<replacement>" \
  --show-title --dry-run

# 2. Apply: the same command without --dry-run.

# 3. Confirm the chain and the corpus accounting.
node apps/curator/dist/main.js verify-audit-chain --db <path>
node apps/curator/dist/main.js verify-corpus-accounting --db <path>
```

Then, in this order:

1. **Rotate the credential.** Redaction removes the text from this store. It does not un-leak it.
2. **Exporter reconcile**, so the exported Markdown file is rewritten:
   `node apps/git-exporter/dist/main.js export --db <path> --out <kb-export dir> --tenant <id> --reconcile`.
3. **Reindex every tenant**, then **scrub the indexes again** to confirm. There is one index
   directory per tenant (section 4.7) and a reindex touches only the tenant it runs for:
   `TEAMKB_TENANT_ID=<tenant> node packages/qmd-adapter/dist/cli.js reindex` for each directory
   under `~/.teamkb/qmd-index/`, then `node packages/qmd-adapter/dist/cli.js scrub-index` (add
   `--scan-fragments-file` if you kept the removed text in a 0600 file).
4. **Take a fresh backup.**
5. **Let older backups age out**, or delete them deliberately. See section 5.
6. Restart the processes you stopped.

### 4.7 The derived-index scrub

**Why it exists.** On 2026-10-04, after `curator redact`, `git-exporter export --reconcile` and
`qmd-adapter reindex`, the redacted text was still under `~/.teamkb/qmd-index/`, for three
reasons:

1. **qmd's own BM25 cache** (`<tenant>/cache/qmd/index.sqlite`) keys content by hash. When a file
   changes or moves, qmd marks the old `documents` row inactive (`active = 0`) and keeps its
   `content` row; `qmd cleanup` removes inactive rows but leaves orphaned `content` rows, and the
   FTS5 segments keep the old tokens until a rebuild.
2. **The native FTS5 index** (`<tenant>/native-fts5.sqlite`) kept the moved document's old row, and
   its `-wal` held the text until a checkpoint truncated it.
3. **There is one index directory per tenant.** `intent-solutions` is the API and CLI tenant;
   `local` is the plugin's default tenant when `TEAMKB_TENANT_ID` is unset. `local` is live: the
   plugin's local-mode `brain_govern` updates it. A reindex touches only the tenant it runs for.

The dense sidecar (`<tenant>/dense-vec.sqlite`) also stores plaintext: the first 160 characters
of each document as its snippet, plus the embedding of the first 2000 characters.

**What it does, per tenant directory it finds** (tenants are discovered, not named):

- Reconciles each index file against `kb-export`, the source of truth for what should be indexed.
  A row goes when its document is not exported at that path with that content: qmd rows by path
  and SHA-256, native FTS5 rows by id and exact text, dense rows by id and the hash of the embedded
  text.
- Removes qmd's inactive rows, orphaned `content` rows, orphaned vector rows and its derived LLM
  cache, and native FTS5 bookkeeping rows for removed documents.
- Rebuilds and optimizes both FTS5 indexes.
- With `secure_delete` on, truncates the WAL, runs `VACUUM` and truncates the WAL again.
- Optionally byte-scans every file under the index directory (databases, `-wal`, `-shm`, anything
  else) for removed fragments. The report names files and counts, never the text.

Removed rows come back from `kb-export` at the next reindex or native refresh, so the scrub costs
recall only for documents whose export is stale.

**Inside `curator-cli redact`.** At redaction time the export has not been reconciled yet, so the
redact run also removes the redacted memory's rows from every tenant's index outright, and keeps
the native index's bookkeeping row so a live refresh does not re-read the old export file. The
memory is missing from search until the exporter rewrites its file and the next refresh or reindex
adds it back. If you reindex before running the exporter, the old text comes back: follow the order
in section 4.6. The curator runs the scrub as a child process (`qmd-index scrub-index`), because the
govern core must build without the retrieval package; the removed text goes to it on stdin, never
in its arguments and never on disk. Point `TEAMKB_QMD_INDEX_CLI` at the CLI if it is not at
`packages/qmd-adapter/dist/cli.js`.

**Standalone.**

```bash
# Preview: read only. Per tenant and file, what would be removed (counts only).
node packages/qmd-adapter/dist/cli.js scrub-index --dry-run --json

# Scrub. Optionally prove a removed value is gone (file must be mode 0600; delete it after).
node packages/qmd-adapter/dist/cli.js scrub-index --scan-fragments-file /dev/shm/removed.txt
shred -u /dev/shm/removed.txt
```

`--index-dir` defaults to `<TEAMKB_BASE_PATH>/qmd-index`; `--export-dir` to `TEAMKB_EXPORT_DIR` or
`<TEAMKB_BASE_PATH>/kb-export`. A fragments file holds one fragment per line.

**Exit codes:** `0` complete (a dry run: every file was read) · `4` incomplete: a database was busy,
a step failed, a mass removal was refused, or (live) removed text is still in an index file · `5`
refused: an index file has an unexpected table layout and was not touched · `2` usage error · `1`
I/O failure. Inside `curator-cli redact`, every index-scrub failure is reported as exit `4`, since
the redaction itself is committed.

**Guards.**

- **Schema pin.** The scrub compares the tables and columns it depends on with the layout recorded
  for the pinned qmd version (`PINNED_QMD_VERSION` in `packages/qmd-adapter/src/scrub/schema-guard.ts`;
  a test fails if the root `package.json` pins a different `@tobilu/qmd`). Any difference refuses
  that file. After a qmd upgrade, re-check the layout before scrubbing.
- **Busy databases.** Each database is opened with a two-second busy wait
  (`--busy-timeout-ms`). A database another process holds is reported by name as `busy` and the run
  exits `4`. Stop the brain API and the MCP-using sessions, or run during a quiet window, and run it
  again. Re-running is safe: the scrub is idempotent.
- **Mass removal.** A reconcile that would remove more than a quarter of a file's documents (and
  more than 50) is refused for that file. That catches a wrong `--export-dir`, and also an index
  that has not been reindexed in a long time: reindex that tenant first, or pass
  `--allow-mass-removal`. A missing or empty export tree disables reconciliation; only targeted,
  inactive and orphan rows are removed then.
- **Dry run.** Writes nothing. A database whose WAL is empty is read from an in-memory copy; one
  whose WAL holds frames is opened read-only in place, which leaves the database and WAL bytes
  unchanged but updates read-lock slots in its existing `-shm`, as every reader does.

## 5. What redaction cannot reach

Stated plainly, because a redaction that claims more than it does is worse than none.

- **Existing backups.** Every backup taken before the redaction still holds the old text: the local
  encrypted archives, the copy on the VPS, the R2 copy, the borg repositories, and the Backblaze B2
  copy. A copy under Object Lock cannot be removed before its retention ends. Redaction does not
  touch any of them. They age out on their retention schedule or are deleted by hand.
- **The exported tree and its history.** `kb-export/` holds a Markdown copy until the exporter
  reconciles. If that tree is committed to git, the old text stays in git history.
- **The search indexes, partly.** The index scrub (section 4.7) removes the text from every tenant's
  qmd cache, native FTS5 index and dense sidecar under the index directory. An index somewhere
  else (another machine, a copied directory, a personal `~/.cache/qmd`) is not reached. The dense
  sidecar's vectors were computed from the old text; the scrub removes the vectors of changed
  documents, but a vector is not text and the byte scan cannot check one.
- **Compile-side and spool artifacts.** A memory that came from a spool file or a compiled wiki page
  has its source text in `spool/`, `brain/raw/` and `brain/wiki/`. Redaction does not edit those.
- **Other rows.** Redaction rewrites one memory and its candidate copies. If the same text is in
  another memory, the byte scan reports that row's table and id so it can be redacted too.
- **Storage below the file.** The scrub removes the text from the three SQLite files. Blocks the
  filesystem has already freed, SSD spare area, and snapshots are outside its reach.
- **Process memory.** A running process that already read the memory still has it until it restarts.
- **Anyone who already read it.** Rotate the credential.

Two more limits worth knowing:

- **The old content hash is an oracle for a weak secret.** The receipt keeps the hash of the old
  content. Someone who knows everything in the old text except a short or guessable secret can test
  guesses against that hash. This is a second reason rotation is step 1.
- **The byte scan is evidence, with a stated blind spot.** It finds a removed fragment only where its
  bytes are contiguous in a file. A row larger than a database page spills into overflow pages, so a
  fragment that straddled a page boundary in the old row can be missed. FTS5 segments store
  stemmed, prefix-compressed tokens, not the text, so the byte scan cannot see a token there; the
  FTS rebuild is what removes them.

## 6. What still works after a redaction

- **`provenance-walk`.** The memory id is derived from the candidate id and the content hash at
  promotion. After a redaction the current hash no longer derives the id, so the walk verifies the
  id against the pre-redaction hash recorded on the `redacted` receipts and checks that the receipts'
  hash history ends at the current hash. A row changed any other way still fails.
- **Dedup.** The stored hash changed, so a plain hash lookup no longer matches the original text. The
  curator, the API promotion path, the API intake path and the candidate insert all check redaction
  receipts and refuse content whose hash is a redacted old hash.
- **Corpus accounting.** The memory keeps its `promoted` receipt.

## 7. Known gaps

- **`merge-govern`.** The merge gate requires `id == deriveMemoryId(candidateId, contentHash)` for
  every clone row and has not been taught about redaction receipts. A clone that contains a redacted
  memory fails that check. The merge path is demand-gated; fix it before the first real merge.
- **A memory row that no longer parses.** Redaction reads the memory through the repository, which
  validates it. A legacy memory row that fails domain validation cannot be redacted by this command.
  Candidate copies do not have this limit.
- **Sensitivity is left as it was.** Redaction does not reclassify the memory, so a memory classified
  `restricted` because of the secret stays `restricted` and stays out of the export tree. That is
  the safe direction. There is no governed command to lower a memory's sensitivity today; if the
  redacted memory should be searchable again, that is a separate decision and a separate change.
- **No API route for redaction.** The scrub runs `VACUUM`, which is an operator act on a quiet store.
  Narrowing has an API route; redaction is CLI-only.
- **Scan mode sees secrets only.** It uses the secret patterns, not the PII patterns.
