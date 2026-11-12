# Skill response-policy evaluation

The adjacent `eval-spec.yaml` files are distinct, hand-authored J-Rig skill
profiles for this repository. They are grounded in source commit `dee0b729228f61d239d4d257b0f49caab4a792b1`;
other BBB repositories have different tool and permission contracts and must
retain their own profiles.

| Skill        | Grounded SKILL.md SHA-256                                          |
| ------------ | ------------------------------------------------------------------ |
| `brain`      | `e1c74ca1c8725b02ad62c0f50ceecc8c47fdec02d1d5549276da2fa068fda9b9` |
| `brain-save` | `ea72f3b8ec632ba04922c9bdbc7000559baa7d2ea54e0a43d206c585ccced323` |
| `teamkb`     | `91a5500c38c1d6c4d887737e00192fab5d859495a25dde3cc6802824c1068c63` |

## What these fixtures measure

Each functional case embeds an explicitly synthetic, already completed tool
transcript in its prompt. Binary judges assess the resulting response against
that transcript: citations, honest uncertainty, read/write separation and truthful
proposal/transition outcomes. No real corpus, token, filesystem write or MCP
service is supplied. These profiles do not prove that a model actually called the
right tool, that a deployed service enforced permissions, or that a write settled.
That requires a separately reviewed execution/trajectory lane.

Trigger-only cases cover explicit invocations, near-sibling requests and an
always-loaded MCP fixture: available tools alone do not authorize activation or writes. They are
adversarial cases with `criteria_ids: []`, so trigger classification runs without
manufacturing functional scores from an unrelated prompt. `brain` reads;
`brain-save` requires explicit invocation for its one-item write workflow.
`teamkb` also requires explicit invocation and keeps batch import confirmation, bounds and read-only review/status modes separate.

## Validation and controlled execution

Validate each profile using the existing J-Rig CLI without provider execution:

```sh
j-rig validate skills/brain/eval-spec.yaml --json
j-rig validate skills/brain-save/eval-spec.yaml --json
j-rig validate skills/teamkb/eval-spec.yaml --json
```

A valid schema is not a model-quality result. The profiles target MiniMax-M3 with
five judge samples and explicit call/token/time budgets. Running them can consume
provider allowance; this source change neither executes them nor enables a
schedule. No budget may be interpreted as a claim that a run finished within it.

The coordinated J-Rig roster change selects a separate immutable source pin for
each repository using `--roster`. Use a clean checkout at the configured SHA and
a separate output directory. Do not reuse a plugin pin for Registrar or vice versa.
Do not edit a pinned checkout to add profiles after verification.

No model acceptance, nightly rollout or release is claimed by this preparation.
Refs bead `bd_000-projects-qkhp`. To roll back, stop selecting the new roster and
revert these additive profiles; existing skill instructions and runtime stay intact.
