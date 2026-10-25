# Generated audit-chain contracts

The store package supplements its existing example tests with six bounded
fast-check properties covering seven audit-chain themes. These tests use synthetic
rows, in-memory databases and private temporary anchor files. They do not read a
live corpus or change production hash, ordering, classification or anchor code.

## Properties and independent expectations

| Theme                             | Observable assertion                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain linkage                     | Generated mixed-version rows form an intact chain under the actual verifier.                                                                                                                      |
| Versioned hash determinism        | A test-owned wire serializer and SHA-256 oracle match production bytes/hashes; literal golden JSON pins both wire orders. Version 1 includes timestamps; version 2 deliberately excludes them.    |
| Hashed-field tamper detection     | Changing each version-hashed field produces a non-fork failure and a tamper signature. Ordering metadata is not claimed to be hashed.                                                             |
| Retained-anchor rewrite detection | A real private database is anchored, edited and fully rehashed. Internal verification remains clean while the retained earlier anchor reports `HISTORY_REWRITTEN`; anchor bytes remain unchanged. |
| Fork classification               | An intact earlier row can explain a fork; a row with a corrupted own hash cannot excuse a later link. Classification remains stable and a manifest cannot absorb a fork.                          |
| Exception non-laundering          | Exact current hash/link/version/sequence and reason pins are required. Null/value, tuple, reason, missing-row and missing-manifest drift cannot become documented exceptions.                     |
| Total order                       | The actual repository returns exact insertion/sequence order despite equal timestamps, reverse UUID order and deliberately out-of-order wall clocks.                                              |

A raw pre-migration row with both hash columns null increases `unverifiedRows`,
not `cleanRows`. The classifier accepts the verifier's break list, rather than its
unverified-row counter; its `verified` flag must not be substituted for an overall
provenance verdict. Tuple/reason drift directly tests classifier inputs; real
in-memory SQLite covers repository ordering and retained-anchor rewrites.

The generated wire oracle does not call the production serializer or hash helper.
This makes it capable of detecting omitted fields and version drift rather than
merely comparing the production helper to itself. SHA-256 collision resistance
remains an assumption; these bounded tests are not an exhaustive proof.

## Bounds and replay

All properties use seed `0x6a10` (decimal `27152`), with generated chains of at most
24 chained rows, plus one raw unverified row in the pre-migration counter
control. Four pure properties run 100 cases each, repository ordering runs 40 and
retained-anchor checking runs 15: 455 generated cases across six test cases.
Default fast-check shrinking remains enabled. No preconditions discard cases and
no production test skip, coverage threshold or exclusion is added.

Run from the repository root:

```bash
pnpm exec vitest run packages/store/src/__tests__/audit-chain-properties.test.ts --maxWorkers=2
```

On failure, fast-check reports the seed, counterexample and shrink path. Restrict
to the reported test name with Vitest `-t`; use the reported `seed` and `path` in
that property's `fc.assert` parameters to replay a minimized counterexample.
The report's `endOnFailure: true` is a replay instruction; normal assertions leave
shrinking enabled. [Fast-check replay parameters](https://fast-check.dev/docs/api/interfaces/Parameters/)
document these options.

## Failure controls and limits

Initial local validation uses temporary transform-only configurations to plant
these seven independent defects without editing production files: timestamp/UUID
ordering in place of sequence ordering, version-2 timestamp inclusion, version-1
timestamp omission, accepting a broken hash as a fork anchor, omitting the
sequence exception pin, omitting the reason pin, and disabling retained-head
comparison. Each selected generated property must fail with a counterexample and
seed/path output. These targeted controls are not a whole-repository mutation
score; unrelated test cases filtered by `-t` are not claimed as executed there.

A retained fixture anchor detects a rewrite only while that earlier anchor is
preserved. This does not establish independent anchor storage, remote durability,
a live audit result or protection against an actor rewriting both local records
and their local anchors. Historical migration exceptions remain historical
records; no live corpus measurement or repair is performed by these tests.
