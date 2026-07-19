# Bob's Big Brain Registrar (the govern engine; repo renamed from qmd-team-intent-kb 2026-07-19) — review context for Greptile

The Registrar is the **deterministic control plane** of Bob's Big Brain. It
consumes the compile engine's (ICO's) spool and runs **dedupe -> policy -> promotion** into an
append-only, hash-chained audit log. It is **not** a qmd fork, **not** git-as-database, and **not**
prompt-only memory governance. TypeScript/Node monorepo (pnpm, Node >= 20).

## The one architecture you must protect: the spool is the trust boundary

```
ICO compile (probabilistic, model-driven)
  -> spool  (the trust boundary: content-stable UUID-v5 + manifest SHA-256)
  -> INTKB govern  (DETERMINISTIC — no model call): dedupe(content_hash)
       -> 8-rule PolicyPipeline -> promote -> curated_memories + append audit_events
  -> git-exporter -> kb-export/ -> qmd BM25 index -> brain_search (qmd:// citations)
```

**The model proposes; deterministic code owns durable state, policy, promotion, and every audit
write.** Nothing below the spool calls an LLM. `packages/policy-engine` is pattern/heuristic logic —
`scanForSecrets` is regex-based even though it imports from a package named `claude-runtime`. A diff
that adds a real model-inference/network call into the policy engine, the promoter, or the audit path
is an architecture violation, not an optimization.

## Prioritize (in order)

- **Govern determinism** — no LLM below the spool; the 8-rule pipeline stays deterministic.
- **Receipt integrity** — `audit_events` are append-only + hash-chained; promotion writes the memory
  and its receipt in ONE transaction; the chain is NEVER re-hashed (ratified D5 — the 155 carried
  CHAIN_FORK breaks are benign same-timestamp ordering, all hashes intact). `ok:false` = real tamper.
- **Source-of-truth data model** — `candidates` is insert-only; retirement is marker-based, never a
  destructive delete of flagged/rejected rows.
- **Secrets at rest** — bearer tokens are scrypt-hashed in `~/.teamkb/tokens.json`; never regress to
  plaintext, never log a token.
- **Deploy safety** — the API runs from an immutable `releases/<tag>` (floor `a2143be`); never a
  working-tree run, never a pre-E1 ref (it double-hashes the hashed tokens and locks everyone out).
- **Gate integrity** — never weaken a CI check (`validate` = lint + typecheck + coverage; `security`
  = gitleaks + Semgrep + audit; `docs-quality` = markdownlint).

## Deprioritize

- Style-only / naming nits — eslint, prettier, and markdownlint already cover these.
- Churn on generated output: `dist/`, `coverage/`, `kb-export/`, `qmd-index/`, `*.map`.
- Comments that merely restate a linter or the typechecker.

## Honesty invariant (brand-load-bearing)

The wedge is **govern + receipts**, not recall. The chain is **tamper-evident**, not tamper-proof.
**Forbidden as product claims:** tamper-proof, immutable, non-repudiation (local mode), blockchain.
Local mode gives integrity + ordering + rewrite-detection; cross-actor attribution needs the pushed
anchor + per-actor signatures.

## Related repos (multi-repo context)

The Registrar is one of the repos under the `intent-solutions-io/bobs-big-brain-umbrella` umbrella.
It is bundled by the public `bobs-big-brain-plugin` (local + team modes) and consumes the spool of
the compile engine (`jeremylongshore/bobs-big-brain-compiler`). Greptile's config schema has no multi-repo key, so these are noted here for
reviewer context. Full topology + the code-verified system map: umbrella `000-docs/005-AT-ARCH` and
`007-AT-SMAP`.
