# @qmd-team-intent-kb/repo-resolver

Multi-repo context resolver. Exposes `resolveRepoContext` for deriving tenant identity, detecting monorepo boundaries, and caching repository metadata from a working directory path. Used to attribute captured memories to the correct tenant and repository across heterogeneous developer environments.

Part of the qmd-team-intent-kb monorepo; see the repository root for license and contribution details.

## Explicit project grouping

`resolveProjectIdentity(repoContext, definitions)` is a pure, opt-in helper for
grouping several repositories into one logical project. For example:

```ts
const project = resolveProjectIdentity(repoContext, [
  {
    id: 'brain',
    repositories: [
      'https://github.com/example/brain-compiler.git',
      'https://github.com/example/brain-registrar.git',
    ],
  },
]);
// Success: { ok: true, value: { projectId: 'brain', matchedBy: 'origin' } }
```

The caller supplies and owns the map. The helper reads no configuration or
environment, retains no previous selection, and never guesses from directory
names. Supported origins are HTTPS, SSH, git+SSH and scp-style network remotes.
Matching uses the existing lowercase remote normalization, ignores user-info and
the `.git` suffix, and keeps hosts and explicit ports distinct. Local paths,
query strings, fragments, percent escapes and dot path segments are refused.
For case-sensitive hosting, this lowercase identity convention may collapse
distinct paths; callers must not use it to distinguish those repositories.

Definitions are bounded and validated before selection. Duplicate project IDs
are invalid; a normalized remote assigned to different projects is ambiguous.
The result distinguishes `InvalidProjects`, `AmbiguousProjects`, `NoRemote`,
`UnsupportedRemote` and `UnmappedRepo`. Errors contain no raw origins or input
payloads. An empty map yields `UnmappedRepo` for a supported origin.

This is a source building block for relevance grouping, not authorization.
Tenant, audience and sensitivity checks remain separate. An origin can be
changed locally and does not attest project membership. The helper is not wired
into capture, search, client startup or session handoff; it establishes neither
project-filtered retrieval nor cross-client continuity.

## Manual bounded briefs

`buildProjectBrief(packet)` composes explicitly selected inputs into a JSON brief.
It resolves the repository through the project map above and refuses a task whose
`projectId` differs. It does not fetch Beads, retrieve memories, verify source
revisions, validate permissions, detect contradictions or assess truth. The caller
must supply already-authorized inputs and check the result before acting.

The packet contains:

- `repo`: an existing `RepoContext`;
- `projects`: the explicit project definitions above;
- `task`: `{ projectId, id, goal, status, nextAction }`, from the selected task;
- `constraints`: mandatory strings;
- `sources`: at least one `{ reference, revision }` selected by the caller;
- `retrievalStatus`: `available`, `unavailable` or `not_requested`;
- `evidence`: `{ projectId, citation, text, state }` items, where `citation` is a
  `qmd://` URI and `state` is `current`, `historical`, `unverified`, `conflicting`
  or `superseded`;
- `maxBytes`: optional serialized UTF-8 byte limit, default 8192, range 256–65536.

Task, constraints, source references and same-project conflicts are mandatory.
If they cannot fit, the builder returns `BudgetExceeded`, not a truncated brief.
Other-project and superseded evidence is omitted with separate counts. Remaining
optional items are considered in caller order and included whole when they fit;
later smaller items can fit after an earlier omission. The budget includes the
result wrapper, JSON escaping and final newline from `serializeProjectBrief`.
It is a byte limit, not a model token estimate.

`requiresReview` flags a declared conflict or unavailable retrieval. A false value
does not grant approval or certify correctness. The output labels all inputs as
caller assertions and evidence as untrusted data. Quoting retrieved instructions
does not guarantee that a downstream model will ignore them. This helper filters
relevance only; it cannot enforce access to content already supplied by a caller.
An available search with zero evidence stays distinct from an unavailable search.
Unavailable/not-requested retrieval with nonempty evidence is rejected.

For a manual invocation after the normal Registrar build:

```sh
node packages/repo-resolver/dist/brief-cli.js < selected-input.json
```

The CLI reads stdin only, limits input to 256 KiB and emits exactly the serialized
result. Exit 0 means a brief was constructed, including one requiring review;
exit 2 means refusal or invalid input. It performs no store/network/model calls
and installs no hook. Error results contain only a kind; successful output contains
the selected task/source/evidence text, so handle stdout at the input's sensitivity.
No installed-client integration or fresh-session continuity is established here.
