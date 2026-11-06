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
