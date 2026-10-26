# Strict recovery qmd registry verification

The recovery-only registry API checks where a selected index reads its files.
Existing collection names do not prove source-path or tenant isolation: qmd2.5.3
keeps configuration in both YAML and SQLite, can skip synchronization using its
cached config hash, and indexes files immediately during `collection add`.
Generic legacy collection setup and retrieval behavior are unchanged.

## Supported profile

Supply an explicit `qmdRuntime` declaration with its independently expected
manifest SHA-256. Strict verification accepts the selected manifest-bound
qmd2.5.3 profile only. A legacy binary or ambient binary pin is refused, even
when it might report the same version. Selection metadata alone is not proof
of successful execution or portable native compatibility.

`inspectRecoveryQmdRegistry` derives the registry and database through
`getQmdTenantEnv` for the explicit base and tenant:

- Registry: `<tenant index>/config/qmd/index.yml`.
- Database: `<tenant index>/cache/qmd/index.sqlite`.
- Command selector: `--index index`, supplied by the shared tenant executor.

The base, tenant index root and export root must already be canonical,
owner-private directories. All five export collection directories must exist.
The inspector creates no directories and performs no SDK initialization, DDL,
permission repair or qmd command. SQLite is opened read-only with
`fileMustExist`; SQLite may still materialize transient WAL/shared-memory files.
This is not a byte-immutability promise for SQLite sidecars.

## Registry contract

The YAML and SQLite `store_collections` records must agree on the exact expected
collection set and canonical source directories from `getExportableCollections`.
Each collection uses `**/*.md`, with no ignore filters, update commands, contexts
or disabled default inclusion. A matching cached config hash does not excuse a
YAML/SQLite disagreement. Unknown fields, malformed YAML, duplicate keys and
aliases are refused. The three nonempty string values qmd persists as model
metadata are accepted; this API does not invoke, download or load those models.

Private bounded no-follow/nonblocking reads reject special registry files.
Physical witnesses bind the main registry/database files, their existing parent
directories and source directories. Existing SQLite sidecars must be ordinary,
nonredirected owner files; their creation/removal between operations is allowed.
The registry digest also binds its bytes. These checks detect replacement at
inspection boundaries; they do not confine another process with the same UID.
The database witness binds file identity, not unchanged database contents.

`allowPartial: true` is an explicit read-only setup inspection. It permits an
absent registry/database pair or matching valid subsets, but returns `partial`.
It never means that indexing or initialization is complete. Conflicting existing
rows and orphan sidecars are still refused. The fixed recovery integration must
inspect before **every** collection addition and inspect the resulting subset
afterward, because adding a collection immediately reads and indexes its files.
It must not use a failing collection listing as an empty-registry fallback.

## Execution and stage verification

`verifyRecoveryQmdRegistry` first requires a complete valid registry, then runs
only the selected `collection list` route. A nonzero or abnormal result refuses
verification. Its output is not parsed as source-path evidence: qmd's rendered
listing omits source paths. The API re-inspects the authoritative files and
requires the command provenance and registry binding to remain unchanged.

Pass a prior complete inspection to verify the same binding after an index
update. `assertRecoveryQmdRegistryBinding` compares the physical witnesses,
registry digest, exact collection names, paths and selected command metadata.
Keep the shared recovery lock across setup, update and verification; this API
does not acquire that lock or implement the surrounding recovery stages.

Registry verification does not establish document freshness, complete export
coverage, absence of historical foreign document payloads, valid citations,
backup readiness or full recovery. Those remain independent parent requirements.

## Evidence and limits

The unit suite uses real YAML and SQLite files with synthetic owned launchers to
exercise routing and refusal contracts. It is not genuine package/native proof.
The explicit `packages/qmd-adapter/scripts/recovery-registry-fixture.mjs` lane
requires an owned artifact root, independently expected manifest digest and
private fixture-proof file. It exercises the real selected qmd package for two
private tenants, inspecting before every cold collection addition, before update
and afterward. It checks one current document per tenant plus foreign-path and
update-hook refusals, and verifies the full artifact inventory before and after.
It performs no live brain, service or model operation and does not prove the
whole recovery export/document denominator or plugin packaging.

Track registry delivery under `compile-then-govern-eqw.8.1.2.7.1`; the fixed plugin
integration remains open under its parent `compile-then-govern-eqw.8.1.2.7`.
