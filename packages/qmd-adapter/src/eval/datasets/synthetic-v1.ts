import type { EvalDataset } from '../eval-types.js';

/**
 * The SELF-CONTAINED, CI-GATED retrieval eval dataset (bead
 * compile-then-govern-6ps.6, Track 2 of the "most-PROVEN" testing initiative).
 *
 * Unlike `governed-brain-v1`, whose gold ids point at the live `~/.teamkb`
 * corpus (so its number can only be produced on a warm dev box and is never
 * enforced in CI), every gold id here resolves against the COMMITTED synthetic
 * corpus under `../fixtures/synthetic-corpus/`. `ci-retrieval-ratchet.ts` builds
 * a throwaway qmd index over those fixtures in a temp dir and runs this set, so
 * the number is reproducible on a cold CI runner with zero access to the real
 * brain. The corpus is also dual-usable as a public showcase — no secrets, no
 * real internal data, just governed-brain-style memories.
 *
 * Id space: `qmd://kb-{curated,decisions,guides}/<basename>.md` — the same space
 * `qmd search` returns for a locally-built index over the fixtures (confirmed:
 * the citation is `qmd://<collection>/<file-basename>`).
 *
 * STRATIFIED, weighted toward semantic (8 lexical, 12 semantic) — the split is
 * the point. `lexical` queries reuse the target's exact headline terms (BM25's
 * home turf → all hit). `semantic` queries are of two deliberate flavors:
 *   - body-overlap paraphrases that avoid the headline but reuse distinctive
 *     body wording (BM25 usually still finds them), and
 *   - synonym / low-overlap paraphrases that restate the concept in words the
 *     doc never uses (the genuine BM25 recall wall → miss).
 * Keeping real misses in the set is what makes the semantic Recall@10 land below
 * 1.0 and gives the ratchet something honest to defend. Queries were NEVER
 * reworded to make BM25 succeed.
 *
 * The `notes` on each query record the observed outcome at label time against
 * `@tobilu/qmd` 2.5.3 (the pinned workspace binary CI runs). See
 * `../ci-retrieval-ratchet.ts` for the gate and `./README-synthetic.md` for the
 * methodology + reproduction.
 */
export const SYNTHETIC_V1_DATASET: EvalDataset = {
  name: 'synthetic-v1',
  idSpace: 'qmd:// citation (synthetic corpus)',
  queries: [
    // --- lexical (8) — exact headline terms; BM25's home turf ---
    {
      id: 'q-lex-01',
      kind: 'lexical',
      query: 'confused deputy problem',
      relevant: ['qmd://kb-curated/confused-deputy.md'],
      notes: 'Exact title term. Gold at rank 1.',
    },
    {
      id: 'q-lex-02',
      kind: 'lexical',
      query: 'hash chain audit log',
      relevant: ['qmd://kb-curated/hash-chain-audit.md'],
      notes: 'Exact concept term (spaces, not hyphens). Gold at rank 1.',
    },
    {
      id: 'q-lex-03',
      kind: 'lexical',
      query: 'compile then govern',
      relevant: ['qmd://kb-curated/compile-then-govern.md'],
      notes: 'Signature architecture name. Gold at rank 1.',
    },
    {
      id: 'q-lex-04',
      kind: 'lexical',
      query: 'token passthrough prohibition',
      relevant: ['qmd://kb-curated/token-passthrough.md'],
      notes: 'Exact anti-pattern name. Gold at rank 1.',
    },
    {
      id: 'q-lex-05',
      kind: 'lexical',
      query: 'row level security',
      relevant: ['qmd://kb-curated/row-level-security.md'],
      notes: 'Exact term. Gold at rank 1.',
    },
    {
      id: 'q-lex-06',
      kind: 'lexical',
      query: 'multi stage docker build',
      relevant: ['qmd://kb-curated/multi-stage-docker.md'],
      notes: 'Exact term (space form; the hyphenated one-token form is weaker). Gold at rank 1.',
    },
    {
      id: 'q-lex-07',
      kind: 'lexical',
      query: 'governed memory positioning',
      relevant: ['qmd://kb-decisions/governed-memory-positioning.md'],
      notes: 'Exact decision title — exercises the kb-decisions collection. Gold at rank 1.',
    },
    {
      id: 'q-lex-08',
      kind: 'lexical',
      query: 'reindex runbook',
      relevant: ['qmd://kb-guides/reindex-runbook.md'],
      notes: 'Exact guide title — exercises the kb-guides collection. Gold at rank 1.',
    },

    // --- semantic, body-overlap (7) — paraphrase avoids the headline but reuses
    //     distinctive body wording; BM25 still finds the gold ---
    {
      id: 'q-sem-01',
      kind: 'semantic',
      query: 'a trusted service is tricked into misusing its authority on behalf of a caller',
      relevant: ['qmd://kb-curated/confused-deputy.md'],
      notes: 'Paraphrase of the confused-deputy concept reusing body wording. HIT.',
    },
    {
      id: 'q-sem-02',
      kind: 'semantic',
      query: 'each entry embeds a hash of the previous entry so editing a past event is detectable',
      relevant: ['qmd://kb-curated/hash-chain-audit.md'],
      notes: 'Definition-style paraphrase avoiding "hash chain"; high body overlap. HIT.',
    },
    {
      id: 'q-sem-03',
      kind: 'semantic',
      query: 'deny an operation by default and only proceed when a request is explicitly permitted',
      relevant: ['qmd://kb-curated/fail-closed.md'],
      notes: 'Concept paraphrase of fail-closed reusing body phrasing. HIT.',
    },
    {
      id: 'q-sem-04',
      kind: 'semantic',
      query: 'the model proposes but the deterministic system owns durable state and control',
      relevant: ['qmd://kb-curated/compile-then-govern.md'],
      notes: 'Restatement of the control-plane thesis; near-verbatim body match. HIT.',
    },
    {
      id: 'q-sem-05',
      kind: 'semantic',
      query: 'a server must reject any credential that was not issued directly to it',
      relevant: ['qmd://kb-curated/token-passthrough.md'],
      notes: 'Restatement of the token-passthrough rule reusing body wording. HIT.',
    },
    {
      id: 'q-sem-06',
      kind: 'semantic',
      query: 'hand a read-only connection to code paths that must never mutate state',
      relevant: ['qmd://kb-curated/dual-pool-postgres.md'],
      notes: 'Paraphrase of dual-pool Postgres avoiding "dual-pool"; strong body overlap. HIT.',
    },
    {
      id: 'q-sem-07',
      kind: 'semantic',
      query: 'use real containers instead of mocks to catch integration bugs',
      relevant: ['qmd://kb-curated/testcontainers.md'],
      notes: 'Paraphrase of testcontainers-based testing reusing body wording. HIT.',
    },

    // --- semantic, synonym / low-overlap (5) — restates the concept in words the
    //     doc never uses; the genuine BM25 recall wall → miss ---
    {
      id: 'q-sem-08',
      kind: 'semantic',
      query: 'a proxy abuses its elevated permissions for an untrusted client',
      relevant: ['qmd://kb-curated/confused-deputy.md'],
      notes:
        'Same concept as q-sem-01 in synonyms the doc never uses (proxy/abuses/elevated/untrusted). MISS — the wall.',
    },
    {
      id: 'q-sem-09',
      kind: 'semantic',
      query: 'a tamper evident ledger where altering history invalidates later entries',
      relevant: ['qmd://kb-curated/hash-chain-audit.md'],
      notes: 'Synonym paraphrase (ledger/altering history/invalidates) of the audit chain. MISS.',
    },
    {
      id: 'q-sem-10',
      kind: 'semantic',
      query: 'refuse everything unless it appears on an allowlist',
      relevant: ['qmd://kb-curated/fail-closed.md'],
      notes:
        'Concept of fail-closed in words (allowlist/refuse everything) the doc never uses. MISS.',
    },
    {
      id: 'q-sem-11',
      kind: 'semantic',
      query: 'keep customers from seeing each other accounts in shared storage',
      relevant: ['qmd://kb-curated/row-level-security.md'],
      notes: 'Tenant-isolation concept in synonyms (customers/accounts) the RLS doc avoids. MISS.',
    },
    {
      id: 'q-sem-12',
      kind: 'semantic',
      query: 'concentrate on a lone objective and ignore interruptions',
      relevant: ['qmd://kb-curated/single-tasking.md'],
      notes:
        'Single-tasking concept in fresh words (concentrate/lone objective/interruptions). MISS.',
    },

    // --- tokenization (5) — hyphen/dot-joined terms (retrieval epic vps.3).
    //     The 2026-07-16 incident class: qmd's keyword-AND tokenizer returns 0
    //     hits when a query term is hyphen- or dot-joined ("governed-brain",
    //     "CLAUDE.md"), even though the term appears VERBATIM in the doc. The
    //     native FTS5 fusion half (vps.2) tokenizes these and matches. These
    //     queries are regression guards for that miss class — labeled against
    //     the FUSED production path. ---
    {
      id: 'q-tok-01',
      kind: 'tokenization',
      query: 'governed-brain MCP registered twice',
      relevant: ['qmd://kb-curated/governed-brain-mcp.md'],
      notes: 'The literal incident query (2026-07-16). qmd-alone: MISS (hyphen). Fused: HIT.',
    },
    {
      id: 'q-tok-02',
      kind: 'tokenization',
      query: 'CLAUDE.md currency fixes',
      relevant: ['qmd://kb-guides/claudemd-currency.md'],
      notes:
        'The second incident query — dotted filename term. On the small synthetic corpus qmd-alone happens to HIT; on the 17k-file live brain it returned 0 hits. Fused: HIT.',
    },
    {
      id: 'q-tok-03',
      kind: 'tokenization',
      query: 'bd-sync three-layer mirror',
      relevant: ['qmd://kb-guides/bd-sync-mirror.md'],
      notes: 'Two hyphenated terms in one query. qmd-alone: MISS. Fused: HIT.',
    },
    {
      id: 'q-tok-04',
      kind: 'tokenization',
      query: 'settings.json attribution drift',
      relevant: ['qmd://kb-guides/claudemd-currency.md'],
      notes: 'Dotted config-file term in the query body. qmd-alone: MISS. Fused: HIT.',
    },
    {
      id: 'q-tok-05',
      kind: 'tokenization',
      query: 'governed brain MCP duplicate registration',
      relevant: ['qmd://kb-curated/governed-brain-mcp.md'],
      notes:
        'Cross-form control: un-hyphenated query phrasing must still reach the hyphenated doc.',
    },
  ],
};

/**
 * The committed RATCHET baseline — the measured per-stratum Recall@10 this
 * dataset produces over the committed synthetic corpus with `@tobilu/qmd` 2.5.3.
 *
 * These are MEASURED, not guessed:
 *   - lexical:  8/8 queries hit  → Recall@10 = 1.0
 *   - semantic: 7/12 queries hit → Recall@10 = 7/12 ≈ 0.5833
 *
 * The ratchet fails (non-zero exit) if either stratum's live Recall@10 drops
 * below its baseline minus {@link RATCHET_EPSILON}. It deliberately does NOT
 * gate on the absolute 0.85 BM25-sufficiency bar — that is a
 * build-the-semantic-path DECISION threshold (ADR 038), not a ship gate. The
 * ratchet only guards against a REGRESSION in the retrieval we already ship.
 *
 * The literals mirror the harness math exactly (`7 / 12` is byte-identical to
 * the mean the eval computes), so a green run has the full epsilon of slack and
 * only a real discrete regression (any query flipping hit→miss) trips the gate.
 * A retrieval IMPROVEMENT never fails; if a `qmd` bump legitimately raises the
 * floor, re-measure and bump these numbers up in the same PR.
 */
export const SYNTHETIC_V1_BASELINE = {
  /** 8/8 lexical queries hit. */
  lexicalRecallAtK: 1.0,
  /** 7/12 semantic queries hit. */
  semanticRecallAtK: 7 / 12,
  /**
   * 5/5 tokenization queries hit on the FUSED path (vps.2 RRF fusion of qmd +
   * native FTS5). Measured with `disableNativeFusion: true` this stratum is
   * 2/5 (the three multi-hyphen/dot queries miss) — the 2026-07-16 miss class
   * this ratchet now permanently guards.
   */
  tokenizationRecallAtK: 1.0,
} as const;

/** Float-noise tolerance for the ratchet; a genuine regression is far larger. */
export const RATCHET_EPSILON = 0.001;
