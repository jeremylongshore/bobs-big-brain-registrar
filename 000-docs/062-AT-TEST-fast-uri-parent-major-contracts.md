# Parent-compatible URI parser contracts

Date: 2026-10-26. Bead: `compile-then-govern-1io.1.12`.
Scope: Registrar source dependencies, not installed services or plugin releases.

## Selected dependency paths

The former global `fast-uri: ^3.1.9` override forced a patched parser outside
both Fastify parents' requested major. Preserve the security floor within each
supported line using `fast-uri@3: ^3.1.9` and `fast-uri@4: ^4.2.3`.

| Actual caller path       | Direct parent               | Parent request | Previous selection | Selection |
| ------------------------ | --------------------------- | -------------- | ------------------ | --------- |
| Stryker → AJV            | ajv 8.20.0                  | ^3.0.1         | 3.1.9              | 3.1.9     |
| App MCP SDK → AJV        | ajv 8.20.0                  | ^3.0.1         | 3.1.9              | 3.1.9     |
| qmd MCP SDK → AJV        | ajv 8.20.0                  | ^3.0.1         | 3.1.9              | 3.1.9     |
| API Fastify → validator  | @fastify/ajv-compiler 4.0.6 | ^4.0.0         | 3.1.9              | 4.2.3     |
| API Fastify → serializer | fast-json-stringify 7.0.1   | ^4.0.0         | 3.1.9              | 4.2.3     |
| API Swagger → resolver   | json-schema-resolver 3.0.0  | ^3.0.5         | 3.1.9              | 3.1.9     |

The regenerated lock adds only `fast-uri@4.2.3` and changes the validator and
serializer dependency edges. Existing package records, workspace importers,
parent versions and all other snapshots remain unchanged. AJV's own parser
remains on major 3 even when a Fastify parent selects major 4 as its explicit
URI resolver. This is range compatibility work, not a claim that the previous
configuration caused an observed production failure.

## Upstream authority

- [Validator 4.0.6 dependency manifest](https://github.com/fastify/ajv-compiler/blob/v4.0.6/package.json)
  requests `fast-uri ^4.0.0`.
- [Serializer 7.0.1 dependency manifest](https://github.com/fastify/fast-json-stringify/blob/v7.0.1/package.json)
  requests `fast-uri ^4.0.0`.
- Official [3.1.9](https://github.com/fastify/fast-uri/releases/tag/v3.1.9) and
  [4.2.3](https://github.com/fastify/fast-uri/releases/tag/v4.2.3) releases fix
  encoded-scheme spoofing (GHSA-w74x-v6f9-j3xg), malformed-host canonicalization
  (GHSA-wjr9-j795-jxcr), relative-reference normalization (GHSA-xhq7-xmqj-769h)
  and suffix-reference scheme injection (GHSA-333x-w4r6-6crp).

## Executable evidence

`tests/support/residual-dependency-security.test.ts` resolves the parser through
all six actual parent installations. It checks their declared dependency ranges,
selected major and patched floor, shared identity within each major and distinct
identity across majors. Every pre-existing URI advisory assertion runs on each
actual selected major, alongside ordinary absolute/relative URI behavior. The
existing qs and SDK IPv6 controls remain unchanged.

Before the override change the new suite produced three failures and 33 passes:
both Fastify parent-major bindings and the independent-major identity check
failed. This reproduces dependency mismatch, not an application exploit. The
same source tests must pass after the graph correction.

The API's `fastify-dependency-security.test.ts` retains real in-process header
validation and schema-reference validation/serialization controls. The MCP
`validator-sdk-contract.test.ts` retains actual SDK transports and validators.
These fixtures neither start a live service nor send attacker input to a real
endpoint. Run the focused tests, complete canonical validation and an unsuppressed
all-severity dependency audit before acceptance. Exact execution receipts belong
to the PR and Bead; this document does not declare pending gates successful.

## Operational boundary and rollback

No endpoint, schema, data migration, model, native runtime or application policy
changes. Merging source does not rebuild an existing plugin release or update a
running service. Consumers need their normal reviewed build/release/deploy.
Rollback is a reviewed revert of the override and lock together, followed by the
same gates; it restores the known major-range mismatch while retaining the old
3.1.9 security floor.
