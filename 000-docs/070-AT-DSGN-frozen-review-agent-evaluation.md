# Frozen review-agent evaluation runner

Source unit: `compile-then-govern-6ps.13.2`, following the supplied-label scorer
in [069](069-AT-DSGN-review-agent-judgment-scoring.md). This adds file integrity,
checkpoint preservation and a command-line runner. It does not establish a real
human golden set, approve a refresh or qualify the operational agent.

## Authority boundary

The caller supplies a trusted SHA-256 for the exact manifest bytes, separately
from the dataset. The runner never adopts a digest found inside that dataset as
its approval. The digest binds the manifest's labels-by-case-hash, input bytes,
thresholds, provenance declaration and revision metadata.

The caller must establish who approved that digest, when, and which genuine
human dispositions support a human-reviewed dataset. A disposition marker or a
hash of a reviewer/evidence record does not authenticate a person. Every dataset
summary explicitly returns `humanAuthorizationVerified: false`, including when
its declared kind is `human-reviewed`. Passing the synthetic self-test is not
human or operational acceptance.

The reference mechanism is the [commit-pinned drift runner](https://github.com/jeremylongshore/intent-eval-lab/blob/4e23c4493e4b268b36cd82ee05a6feee254a2a20/scripts/drift-eval-runner.py).
Its integrity-before-scoring and subprocess self-test patterns are used here;
the three-class calculations remain owned by `scoreReviewJudgments`.

## Dataset layout and contract

A dataset directory contains exactly `manifest.json` and a `cases/` directory.
Each selected case is exactly `cases/<id>.json`; no caller-supplied relative file
paths are accepted. Predictions and the prior checkpoint file live outside this
directory. Unknown files, missing cases, non-regular files, symlinks, redirected
ancestors and hardlinked selected files refuse. Reads are bounded to 1 MiB per
file, 64 MiB for the manifest plus selected cases, and 10,000 cases/predictions.
Exceeding a bound fails explicitly rather than truncating the selection.

A manifest has these fields:

```json
{
  "schemaVersion": 1,
  "datasetId": "example",
  "kind": "synthetic",
  "revision": 1,
  "previousManifestSha256": null,
  "recallFloors": { "promote": 1, "hold": 1, "reject": 1 },
  "cases": [{ "id": "example-case", "sha256": "<64 lowercase hex characters>" }]
}
```

The digest above is a placeholder, not usable evidence. These example floors
are synthetic controls, not adopted thresholds for the real review agent. A
complete scoring set must satisfy 069's overall class and paraphrase support
requirements; the one-case example only illustrates the file schema.

Each case file contains `schemaVersion: 1`, the matching `id`, `expected`
(`promote`, `hold` or `reject`), `stratum`, `input` and `disposition`. Input is
`{"candidate":"...","context":["..."]}`. Synthetic dispositions are
`{"kind":"synthetic"}`. A human-reviewed case declares
`{"kind":"human","reviewerIdSha256":"<digest>","evidenceSha256":"<digest>"}`;
it must match the manifest's declared kind. All fields are strict. The case's
hash covers its complete bytes, including the input, label and disposition.
Private real cases stay outside the repository unless specifically cleared.

Before emitting a verification summary or scoring, the reader verifies the
independent manifest pin, schema, every selected case hash, identity, declared
kind and exact inventory. It checks regular-file identities and metadata around bounded reads, and
rechecks the current manifest and selected cases at the end of capture. Directory identity and
inventory are rechecked. It scores the captured, verified values, not a later
unverified reread of labels. This is not continuous filesystem monitoring or
an atomic filesystem snapshot, and it does not prevent a local writer from
changing files after the read. The report identifies the captured manifest.

## Preserving a prior checkpoint

Revision one has a null predecessor and refuses a supplied prior checkpoint.
Every later revision requires both `--previous-manifest` and an independently
trusted `--previous-sha256`, matching its declared predecessor. The prior
manifest is itself schema/hash checked. It is a trusted accepted checkpoint;
the runner does not re-audit an entire historical chain or authenticate its
human approval.

The next revision must advance by exactly one, retain dataset ID, kind and
floors, preserve every prior ordered case entry and add at least one case.
Current case bytes must still match those retained hashes. Deletions,
reordering, replacement labels/inputs/strata and quiet floor changes refuse,
even if an editor re-hashes the modified case and current manifest. A new
approved digest is still required for the addition; this check never grants
approval itself.

## Commands and output

After installing the workspace dependencies, run from this repository:

```bash
pnpm --filter @qmd-team-intent-kb/eval-surface review:eval --help
pnpm --filter @qmd-team-intent-kb/eval-surface review:eval --self-test
pnpm --filter @qmd-team-intent-kb/eval-surface review:eval \
  --verify-manifest --eval-root /path/to/dataset --manifest-sha256 "$APPROVED_DATASET_SHA"
pnpm --filter @qmd-team-intent-kb/eval-surface review:eval \
  --score /path/to/predictions.json --eval-root /path/to/dataset \
  --manifest-sha256 "$APPROVED_DATASET_SHA"
```

The eval package is included in the root TypeScript project references, so
`pnpm build` or `pnpm typecheck` emits its library and CLI with the other
workspace projects. After building, `node packages/eval-surface/dist/review-agent-eval-cli.js`
accepts the same arguments and does not require a TypeScript loader. A compiled
CLI subprocess test guards this root-build wiring.

For later revisions add `--previous-manifest /path/to/prior.json` and
`--previous-sha256 "$APPROVED_PRIOR_SHA"`. The variables represent caller-owned
approved pins, not values automatically approved by these commands.

Predictions use a strict JSON envelope:
`{"schemaVersion":1,"manifestSha256":"<approved digest>","predictions":[{"caseId":"example-case","label":"hold"}]}`.
The envelope must name this exact manifest. Missing predictions remain misses;
unknown IDs, duplicate predictions and invalid labels refuse. The report
contains dataset identity/digests and 069's metrics, never candidate/context
bodies or human evidence records. Failures have a generic error, without paths,
raw parser output or stack traces.

Exit 0 means verified evidence or a passing score; exit 1 means recall/support
failure; exit 2 means invalid usage or evidence. Neither exit 0 nor the word
`verified` establishes human approval or production readiness.

Only `--self-test` creates files, exclusively in its disposable synthetic
directory. It starts actual runner processes and checks their JSON responses
and exit statuses for perfect predictions, all-HOLD/missing predictions,
missing class support, byte/pin mutations, valid additions and re-pinned
replacement of an old label. It cleans up its fixture directory. Ordinary
verify/score operations perform no writes, model calls, network requests,
governance operations or label harvesting.

## Remaining parent work

`compile-then-govern-6ps.13` still requires genuine human dispositions, the
human commit/refresh gate, actual agent predictions and operational acceptance.
The real paraphrase-duplicate stratum remains under `6ps.7`. Synthetic source
controls and this runner do not close either obligation. Existing release,
Plugin distribution and live activation holds remain separate.
