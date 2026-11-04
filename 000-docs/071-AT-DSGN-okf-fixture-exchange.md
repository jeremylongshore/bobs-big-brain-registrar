# OKF fixture exchange experiment

Bead: `compile-then-govern-1io.2`. Status: implemented experiment, synthetic
fixtures only. This is a private evaluation surface, not a deployed importer,
export permission service, public interoperability promise, or standards certification.

## Pinned sources

- [Google OKF SPEC.md v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md),
  revision `ad30107c31c06aec8a7d5636e0d1058118604e6f`, SHA-256
  `26aa5da029278939f914e578107242d9607d4f2dc5fe153272b82f9ed1030101`.
- [ArcKit source](https://github.com/tractorjuice/arc-kit/tree/f80a67228aa04206da695cfbd9f7c9702dd4c403),
  revision `f80a67228aa04206da695cfbd9f7c9702dd4c403`. Inspected and ran only
  `plugins/arckit-claude/scripts/{export-okf,import-okf}.mjs`, their
  `hooks/okf-frontmatter.mjs` helper, and `config/{doc-types,okf-types}.mjs`.
  These have only Node built-in imports after resolving that closure. No plugin,
  proprietary UK overlay, server, model, or provider account was used.

The separate Google repository is canonical for this pin; the historical
knowledge-catalog copy is frozen. Revision pins describe what was tested, not an
automatic promise about future versions. Source hashes and author-observed results
are in [the experiment observations](071-okf-fixture-observations.json).

## Mapping and admission boundary

`packages/eval-surface/src/okf-fixture/` contains pure functions with no filesystem,
network, store, executor, attester, or model access. YAML is an explicit, exact
`yaml@2.9.1` dependency of this private package. No application entrypoint invokes
the experiment.

`exportGovernedOkfFixture` requires a schema-valid record in the selected tenant,
public sensitivity at both record and optional metadata levels, exportable audience,
and an exact content hash. The caller remains responsible for selecting genuinely
synthetic, publishable content. The experiment does not independently authorize release.
The bundle contains a root `index.md` with only `okf_version: "0.2"`, an untyped
dated `log.md`, and one `Governed Memory` concept. `sources.resource` uses an inert
`urn:bbb:memory:<id>`, not an invented public endpoint.

The `bbb_fixture` extension preserves the original governed record, including
source, author, lifecycle, sensitivity, trust, hash, promotion and policy records.
An active lifecycle maps to `stable`; other lifecycles map to `deprecated` with
their exact original state retained in the extension. This is a coarse exchange
mapping, not identical lifecycle semantics. Promotion does not manufacture
`verified`, `generated`, independent verification, or a signed receipt.

`proposeOkfFixtureImport` returns schema-valid `inbox`/`import`/`untrusted` candidates,
with a fixed system importer identity, target tenant from caller context, low
confidence, owner audience, and internal sensitivity. It never inserts a record or
sets an origin token. Foreign author, tenant, trust, status, executor, verification
and attestation fields cannot override those values.

All foreign frontmatter and the exact original body are retained as inert JSON in
the existing `metadata.projectContext`; no global schema extension is required.
Candidate content is explicitly trimmed to match the existing candidate schema;
the packet retains the exact original body and its separate hash. Empty-body
concepts can parse but are unsupported as BBB proposals. Unknown types and optional
fields survive this mapping. Original IDs remain claims, never adopted identities.

Candidate identity reuses the canonical `deriveCandidateId` namespace and formula.
Its virtual workspace is scoped by the target tenant hash, virtual path by a
canonical JSON packet revision and original concept path, and body hash by the
actual trimmed candidate content. Packet revision includes foreign metadata and
exact body, but excludes intake time. Metadata changes therefore cannot silently
reuse an earlier proposal ID; YAML key ordering alone does not change it. The
virtual path and original concept path are both retained. This does not change the
compiler spool identity contract or implement a new deduplication policy.

The disposable SQLite test inserts the ordinary proposal through
`CandidateRepository`, evaluates `PolicyPipeline` with an explicit minimum-trust
rule, observes rejection, and checks that no curated row exists. Another test
puts a synthetic credential only in foreign frontmatter: serialization preserves
it in `projectContext`, and the real repository disclosure gate rejects insertion.
These demonstrate the existing boundary, not that all possible policies reject
every import or that a trusted caller cannot separately invoke other APIs.

## Parsing, claims and limits

Only nonempty string `type` is universally required for concepts. Reserved names
`index.md` and `log.md` at any depth are identified before requiring concept type.
Noncanonical reserved frontmatter is reported and never becomes a concept.
Reserved-file body outlines and complete version compatibility are not validated.

Malformed syntax, duplicate YAML keys, aliases/anchors, explicit tags, complex keys,
nonfinite numbers, negative floating zero, and integers outside JavaScript's safe
range are rejected as unsupported by this JSON-compatible profile. This does not
make them universally invalid OKF. Unknown JSON-compatible keys, nested values and
prototype-shaped names survive; parsed mappings use null prototypes. YAML style,
comments, anchors, key order and scalar spelling are not presentation-preserved.
Error codes exclude parser snippets and foreign content.

Limits are 64 entries, 1 MiB total UTF-8 bytes, 256 KiB per document, 32 KiB per
frontmatter, 4,096 inspected YAML nodes and depth 16. Entry paths are restricted to
ASCII alphanumeric/underscore/hyphen starts with subsequent dots permitted, a
`.md` suffix, 255 characters and eight components. Duplicate paths, absolute
entry paths, backslashes, dot components and percent-encoded entry paths reject.
These filename limits deliberately exclude some otherwise valid OKF bundles.

Bundle references support leading `/` as bundle root and `..` only while confined
to that root. Decoding is single-pass; residual percent escapes, backslashes,
control/space characters, network-path references and root escape reject. URI
schemes are inert references, never fetched or executed. Inspection covers simple
inline Markdown links and recognized resource/computation/executor/attester
fields. It does not cover every Markdown/reference-link/HTML syntax. Broken links
produce diagnostics rather than format rejection. A source population descriptor
is not assumed to be a path; only explicit path/URI spellings are inspected there.

`verified` mapping/list shapes produce informational unverified, machine-confirmed,
or human-reviewed claims; malformed entries produce diagnostics. `stale_after`
requires an offset-aware, calendar-valid timestamp; equality is stale. Unknown
status and malformed generated/sources claims remain preserved with diagnostics.
Attested Computation checks basic runtime, computation presence, parameter and
executor/attester shapes, and receipt presence. It always reports that computation
semantics and attestation were not validated. These checks are partial, advisory
contract inspection, not proof of computation, execution, receipt validity or
human identity. No imported freshness or verification tier grants access or trust.

## Observed ArcKit compatibility

The Node CLI experiment ran in `/tmp` against one synthetic project and separate
temporary bundle directories. ArcKit's `--dry-run` still writes its JSON report
under the supplied fixture cwd; it materialized no research note. It never ran
against company projects or a live corpus.

| Direction                              | Observed result                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| BBB governed export → BBB proposal     | One concept, provenance/lifecycle retained, one untrusted proposal                     |
| ArcKit export → its own dry-run import | One valid artifact, two skipped metadata files, zero materialized                      |
| Minimal typed concept → ArcKit dry-run | One valid artifact, zero invalid, zero materialized                                    |
| Full BBB bundle → ArcKit dry-run       | Zero valid, three invalid, zero materialized                                           |
| ArcKit export → BBB                    | One untrusted proposal, two reserved-frontmatter diagnostics, one broken resource link |

The full BBB concept fails ArcKit's restricted YAML parser at the nested provenance
record. Canonical root index fails its required-type check; canonical untyped log
fails its frontmatter check. Conversely ArcKit's exporter assigns concept types to
reserved index/log files, so BBB reports their noncanonical frontmatter and skips
them. Its artifact resource points to the original project path; relative
resolution from the exported concept yields a broken bundle link. No path is fetched.
These are measured limitations, not claims that either implementation conforms in
full or that ArcKit's stated OKF-shaped profile promises complete v0.2 support.

## Reproduce and scope

Run the deterministic local fixtures from repository root:

```bash
pnpm typecheck
pnpm exec vitest run packages/eval-surface/src/__tests__/okf-fixture.test.ts
```

The committed ArcKit-generated synthetic artifact is
`packages/eval-surface/src/__tests__/fixtures/okf/arckit-requirements.md.txt`.
The fixture suite also generates the governed export, re-imports it and checks the
admission boundary. It does not download or execute third-party code in CI.

For a separate ArcKit CLI experiment, retrieve the five exact pinned files listed
above, verify the observation-file hashes, preserve their `scripts/`, `hooks/`
and `config/` layout under a new disposable directory, and create
`projects/001-fixture/ARC-001-REQ-v1.0.md` containing synthetic Markdown only.
Run from that disposable root, using its own `--cwd` explicitly:

```bash
node scripts/export-okf.mjs --project 001 --out exported --cwd "$PWD"
node scripts/import-okf.mjs --project 001 --bundle exported --dry-run --cwd "$PWD"
```

Repeat the importer on a separate directory containing the BBB function's returned
entries, and on one minimal `type: Reference` concept. Report timestamps and source
file modification times vary; the claims are the structural results above, not
byte-identical CLI stdout. The committed observation file is an author record,
not a signed independent attestation.

No live corpus import/export, production command, serving platform, plugin change,
release, deployment, attestation, or broad compliance claim is part of this bead.
Rollback is removal of the private adapter, explicit dependency and tests; there
is no migration or persistent runtime state to reverse.
