# Owned qmd runtime candidate

This private production package is an artifact preparation boundary. It does not
change registrar binary discovery or activate a plugin/runtime deployment.

After its importer is installed from the reviewed registrar lock, run
`node scripts/stage-qmd-runtime.mjs` from the registrar checkout. The stager
projects the selected lock snapshots and verifies their installed dependency
edges. It copies those installed package files, including existing built native
addons, and synthesizes only the projected selected edges as relative links under
private snapshot directories. It performs no dependency resolution, package
manager deployment, lifecycle hooks, native build, model download or install.

This replaces pnpm 9 deployment for artifact preparation: diagnostic deployments
produced an undeclared workspace alias and omitted an installed better-sqlite3
addon. The copier neither permits those aliases nor repairs an incomplete deploy.
Package and alias names are checked before writes. Snapshot directory names are
hashes with collision checks; package-local dependency links and the root qmd
link remain within the fresh candidate. No generated hoists or bin shims are
needed by the compiled Node launcher.

The source and copied dependency inventories must match file bytes and modes.
Fresh source-edge resolution and source file hashes are checked again after the
copy. Missing required or host-compatible optional dependencies, undeclared
package nodes, outside/dangling links and content drift are refusals. The package
inventory is limited to 2 GiB. A successful stage prints a private candidate
directory and manifest hash.

The manifest records expected lock archive integrities separately from hashes of
actual installed source files and copied native files. These are different kinds
of evidence: no registry tarball verification or native ABI compatibility follows
from copying an installed addon. The candidate is tied to its observed host
platform, architecture, libc and Node ABI.

Invoke the candidate with an explicitly selected Node 22 or newer executable:
`node <candidate>/bin/owned-qmd.mjs <qmd arguments>`. Use ordinary Node module
resolution; `--preserve-symlinks-main` is unsupported. The launcher verifies the
recorded inventory and graph, then runs published qmd dist with that same
`process.execPath`, without shell, source-mode or Bun discovery. MCP quiet-log
and Darwin residency initialization follow the hash-pinned upstream launcher.
Arguments are passed literally. Its children remain in the caller's process group.

The owned launcher supports MCP stdio, and refuses any parsed `--http` option
before starting qmd, including reordered and `--http=...` forms. This applies even
on help or non-MCP commands. Actual `--` literal arguments and flag-shaped string
option values remain unchanged. The parser follows the pinned qmd 2.5.3 grammar;
review it when changing that CLI. This is a launcher capability restriction, not
a patch to the included HTTP server: invoking qmd dist directly or using an
explicit external/global binary is outside this control. Previously staged
artifacts retain their original behavior; regenerate the candidate and review its
new manifest digest before selecting this restriction.

The source-only correspondence controls in
[`tests/support/owned-qmd-runtime.test.ts`](../../tests/support/owned-qmd-runtime.test.ts)
compare all 40 option entries and every field plus the complete captured parser configuration
against metadata extracted from the SHA-256-pinned installed upstream CLI.
Checked structured snapshots preserve values that JSON would alter or omit;
Non-enumerable, symbol-keyed, inherited and accessor properties refuse rather
than vanish.
Only exact captured realm object/array prototypes (or null) are accepted, and
their own property descriptors and parent links must stay unchanged during
evaluation. This compares evaluated metadata values, not source text, AST or
property-order identity.
The sole intentional difference is owned `tokens: true`, required for the
capability guard; upstream does not request tokens. Nonempty literal arguments
and every other configuration field must match; unexpected top-level switches
refuse. Controls cover altered arguments, disabled tokens and an added switch.
They execute only isolated metadata snippets, never import qmd or its native
runtime, and reject deliberate copied-table mutations. The existing upstream
byte tripwire and literal/greedy/unknown-option controls remain in place.

The manifest is an integrity receipt, not an independent signature or trust
anchor. Portability, clean-platform native provisioning, model execution,
configured serving identity and deployed identity need separate evidence.
