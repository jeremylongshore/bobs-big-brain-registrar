# Review-agent judgment scoring

Source unit: `compile-then-govern-6ps.13.1`, under the unfinished review-agent
evaluation task `compile-then-govern-6ps.13`. This measures supplied decisions;
it does not run an agent or authorize a governance write.

## Contract

`scoreReviewJudgments(cases, predictions, floors)` is a pure evaluator exported
by `@qmd-team-intent-kb/eval-surface`. A case has an opaque `id`, an `expected`
label and a `stratum`. A prediction has `caseId` and `label`. The three labels
are `promote`, `hold` and `reject`. IDs and strata use 1–96 ASCII letters,
digits, dots, hyphens or underscores, starting with a letter or digit.

All three recall floors must be supplied before scoring, as finite numbers
greater than zero and at most one. The evaluator does not choose thresholds
from predictions. Test thresholds are synthetic controls, not adopted company
policy or evidence of measured review-agent performance. A caller remains
responsible for independently freezing the applicable labels and thresholds.

The report contains the full three-by-four confusion matrix: expected class
against predicted class or `missing`. Each class reports support, predicted
count, hits, misses, false positives, recall and precision. A hold on a case
that should promote or reject counts as a miss for that expected class and
a false positive for hold. An omitted prediction counts as a miss even when
the expected class is hold. Zero predictions for a class give null precision;
zero expected support gives null recall and fails the overall gate.

The evaluator gates each overall class independently using the exact ratio,
without rounding. It also requires reject-labeled support in the
`paraphrase-duplicate` stratum and applies the same reject recall floor there.
Its separate confusion matrix exposes over-promotion of near duplicates:
many easy rejections elsewhere cannot compensate for missing this stratum.
Other strata get full class metrics; they have no additional implied floors.

An empty dataset, malformed records or thresholds, duplicate case/prediction
IDs and predictions for unknown cases refuse with a generic error. The error
does not reproduce the invalid payload. Missing predictions are measurable
misses rather than parse failures. Inputs are parsed into detached values;
the evaluator does not mutate caller data or retain its mutable floor object.

## Authority and remaining integration

This source unit does not authenticate a human label, verify source files or
establish that thresholds were approved before an experiment. A caller that
supplies its own labels can obtain a mathematically correct score for those
labels; that score is not evidence they are genuine human judgments.

The existing reference mechanism was inspected at
`intent-eval-platform/intent-eval-lab/scripts/drift-eval-runner.py`. It verifies
frozen SHA-bound cases before scoring, rejects duplicate or unknown predictions,
counts missing positive predictions as misses and provides an actual subprocess
`--self-test` with a planted file mutation. Its binary drift task is distinct
from Bob's review-agent three-class task; it is not silently repurposed here.

The full parent still requires the frozen SHA-bound dataset and runner,
preservation of prior cases across approved additions, `--self-test`, real
human disposition evidence and a human gate on label refresh, actual agent
predictions, and operational acceptance. Agent verdicts must never supply their
own gold labels. The related real paraphrase-duplicate dataset task `6ps.7`
also remains open. The synthetic tests here do not create that live golden set
or qualify the deployed agent. No model, network, database, audit or file-write
operation occurs inside the evaluator.

## Verification

Synthetic controls include perfect predictions; all-promote, all-hold and
all-reject classifiers; missing predictions for every class; missing class
support; missing paraphrase support; over-promotion masked by many easy
rejections; exact versus rounded floor boundaries; invalid inputs; and detached
input handling. Owning repository gates and normal source review remain
required before this unit is closed.
