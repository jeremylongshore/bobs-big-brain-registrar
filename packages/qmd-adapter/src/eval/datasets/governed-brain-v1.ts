import type { EvalDataset } from '../eval-types.js';

/**
 * The FIRST REAL hand-labeled retrieval eval dataset for the Governed Second
 * Brain (bead compile-then-govern-e06.4 / umbrella #27 / ADR 038-AT-DECR).
 *
 * Unlike the seed/placeholder set, every gold `relevant` id here is a real
 * `qmd://` citation drawn from the live `~/.teamkb` corpus (tenant
 * `intent-solutions`), confirmed present in the export tree. Queries are
 * stratified `lexical` (exact term/name — BM25's home turf) vs `semantic`
 * (paraphrase/concept that avoids the target's headline keywords), WEIGHTED
 * toward semantic because that is the stratum where the recall wall shows up
 * and where ADR 038 weights the BM25-vs-sqlite-vec decision.
 *
 * Composition: 42 queries — 14 lexical, 28 semantic.
 *
 * Methodology + reproduction: `./README.md`. Run: `pnpm eval:retrieval`.
 * `notes` records the empirical observation (gold rank / BM25 miss) at label
 * time — a BM25 miss on a valid semantic query is kept, not discarded.
 */
export const GOVERNED_BRAIN_V1_DATASET: EvalDataset = {
  name: 'governed-brain-v1',
  idSpace: 'qmd:// citation',
  queries: [
    {
      id: 'q01',
      kind: 'lexical',
      query: 'confused deputy problem',
      relevant: ['qmd://kb-curated/00c95f4e-e1ee-51ad-9331-3aefd68a1629.md'],
      notes:
        'Exact title term. Gold at rank 1 (score 0.95). BM25 nails the named security anti-pattern.',
    },
    {
      id: 'q02',
      kind: 'lexical',
      query: 'compile then govern',
      relevant: [
        'qmd://kb-curated/c68ad991-6134-50c8-a577-2aa12c4e9d81.md',
        'qmd://kb-curated/081bce4f-1801-539d-a852-add50f441e50.md',
      ],
      notes:
        'Signature architecture name. Both gold docs (Compile-Then-Govern rank 1, Compile-Then-Govern Architecture rank 3) in top-10.',
    },
    {
      id: 'q03',
      kind: 'lexical',
      query: 'hash chain audit log',
      relevant: ['qmd://kb-curated/03a1e7c7-9b85-58fb-aa77-08ac74e8486a.md'],
      notes:
        "Exact concept term (spaces, not hyphens). Gold 'Hash-Chain Audit Log' at rank 1 (0.90). Hyphenated 'hash-chain' string returns 0 due to strict-AND tokenization; space form works.",
    },
    {
      id: 'q04',
      kind: 'lexical',
      query: 'rapid write race condition',
      relevant: ['qmd://kb-curated/d09ddcef-9754-5ef4-8402-0fe397ebe4ce.md'],
      notes:
        "Named bd-sync bug. Gold 'Rapid-Write Race Condition' at rank 1 (0.96). Note: 'bd-sync' as a bare hyphenated token returns 0; the descriptive phrase hits.",
    },
    {
      id: 'q05',
      kind: 'lexical',
      query: 'pgvector HNSW index parameters',
      relevant: ['qmd://kb-curated/46c53844-2b99-53d4-94be-9bfc538e4ca9.md'],
      notes:
        "Exact technical terms. Gold 'pgvector Extension' at rank 2 (0.96); an open-question guide about HNSW params is rank 1. Gold in top-10.",
    },
    {
      id: 'q06',
      kind: 'lexical',
      query: 'row level security',
      relevant: ['qmd://kb-curated/c39f9b40-f1cf-5e96-b6af-47faa598e935.md'],
      notes:
        "Exact term. Gold 'Row Level Security (RLS)' at rank 1 (0.90). Adding trailing token 'RLS' + 'multi-tenant' can drop it to 0 under strict-AND; the clean term hits.",
    },
    {
      id: 'q07',
      kind: 'lexical',
      query: 'single tasking',
      relevant: ['qmd://kb-curated/03badc0d-fd42-5f8d-b63b-f074d3d69cd0.md'],
      notes:
        "Exact productivity concept. Gold 'Single-Tasking' at rank 2 (0.87); an open-question guide about single-tasking is rank 1. Gold in top-10.",
    },
    {
      id: 'q08',
      kind: 'lexical',
      query: 'curated only default search',
      relevant: ['qmd://kb-curated/5c600718-4993-5ae6-b0e3-125a25bae51d.md'],
      notes:
        "Exact design-decision term. Gold 'Curated-Only Default Search' at rank 1 (0.93). Hyphenated 'curated-only' as one token returns 0; space form hits.",
    },
    {
      id: 'q09',
      kind: 'lexical',
      query: 'beads post compaction recovery',
      relevant: [
        'qmd://kb-curated/d2dd0c93-851d-526e-9f26-4e14b5dd6dff.md',
        'qmd://kb-curated/6dc4a43f-3b1e-577d-9b21-fffd78e35425.md',
      ],
      notes:
        'Exact feature terms. Both gold docs in top-10 (Post-Compaction Recovery (Beads) rank 1, Task Tracking and Post-Compaction Recovery with Beads rank 3).',
    },
    {
      id: 'q10',
      kind: 'lexical',
      query: 'SOPS age secrets management',
      relevant: ['qmd://kb-curated/6243141f-aa38-4a4b-b3e7-87df102befc7.md'],
      notes: "Exact tooling name. Gold 'SOPS + Age Secrets Management' at rank 1 (0.94).",
    },
    {
      id: 'q11',
      kind: 'lexical',
      query: 'Z3 formal verification',
      relevant: ['qmd://kb-curated/270376d1-cdf5-58e0-86f5-29f1c8ae5d1f.md'],
      notes: "Exact named technique. Gold 'Z3 Formal Verification' at rank 1 (0.95).",
    },
    {
      id: 'q12',
      kind: 'lexical',
      query: 'ultralight travel',
      relevant: ['qmd://kb-curated/69bf58b3-35d0-5588-8199-9b0a2292034b.md'],
      notes:
        "Exact lifestyle topic title. Gold 'Ultralight Travel' at rank 1 (0.96). Only 2 docs match.",
    },
    {
      id: 'q13',
      kind: 'lexical',
      query: 'spool boundary threat model',
      relevant: ['qmd://kb-curated/45e98c3c-8da9-5e73-ae55-6ec24012fbfd.md'],
      notes:
        "Exact security-doc title. Gold curated 'Spool Boundary Threat Model' at rank 1 (0.95).",
    },
    {
      id: 'q14',
      kind: 'lexical',
      query: 'token passthrough prohibited MCP',
      relevant: ['qmd://kb-curated/2effddb9-ded0-5d50-a16b-c5b1df16b3e3.md'],
      notes:
        "Exact anti-pattern name plus qualifier. Gold 'Token Passthrough' at rank 1 (0.95). Adding the token 'anti-pattern' alone returns 0 (not in doc); 'prohibited MCP' co-occur and hit.",
    },
    {
      id: 'q15',
      kind: 'semantic',
      query: "when a server gets tricked into using its own credentials for someone else's request",
      relevant: ['qmd://kb-curated/00c95f4e-e1ee-51ad-9331-3aefd68a1629.md'],
      notes:
        'Plain-language paraphrase of the confused-deputy concept, deliberately avoiding the term. Gold NOT in top-10 (0 results) — genuine BM25 miss: no single doc contains all these common tokens under strict-AND.',
    },
    {
      id: 'q16',
      kind: 'semantic',
      query:
        'the model can propose actions but the deterministic system owns durable state and control',
      relevant: [
        'qmd://kb-curated/316bf636-cc61-507b-afa9-1d811ed441d7.md',
        'qmd://kb-curated/44021ba6-1510-5393-b2d0-7b483b706ea2.md',
      ],
      notes:
        "Paraphrase of the deterministic-control-plane thesis without the headline term. Gold NOT in top-10 — only 'Bead-Based Project Management Methodology' returned (unrelated); a BM25 miss on both control-plane docs.",
    },
    {
      id: 'q17',
      kind: 'semantic',
      query: 'do one thing at a time with presence and gratitude to feel less overloaded',
      relevant: ['qmd://kb-curated/d7e5a1fe-6b9a-5d53-88df-678cd7ad72e3.md'],
      notes:
        "Paraphrase of Mindful Focus avoiding the title words. Gold 'Mindful Focus' NOT in top-10 — only a 'Primer' guide (not the gold) returned; genuine miss on the curated concept doc.",
    },
    {
      id: 'q18',
      kind: 'semantic',
      query: 'why do I keep filling every quiet moment so I never have to sit still',
      relevant: ['qmd://kb-curated/fcfb7a3c-c9ad-5925-8c91-5b89a6a90f94.md'],
      notes:
        'Everyday-language paraphrase of Fear of Space, no headline keyword. Gold NOT in top-10 (0 results) — BM25 miss.',
    },
    {
      id: 'q19',
      kind: 'semantic',
      query: 'overcome procrastination by observing urges and releasing false comforts',
      relevant: ['qmd://kb-curated/f9a94d2d-8baf-5c5a-9a03-368c5bae8fb9.md'],
      notes:
        "Paraphrase of the 'Letting Go' method. Curated gold 'Letting Go' NOT in top-10 — a related blog guide (How I Learned to Stop Procrastinating) hit rank 1 instead, but that is not the labeled gold; miss on the concept doc.",
    },
    {
      id: 'q20',
      kind: 'semantic',
      query: 'a green checkmark that passes even when the tool could not run launders trust',
      relevant: ['qmd://kb-curated/51be40a8-5575-5730-9f9f-6483cb32903a.md'],
      notes:
        'Paraphrase of Honest-Gate Culture. Gold NOT in top-10 (0 results) — BM25 miss despite reusing some body wording; token set does not fully co-occur.',
    },
    {
      id: 'q21',
      kind: 'semantic',
      query:
        'each entry contains a cryptographic hash of the previous entry so tampering breaks the chain',
      relevant: ['qmd://kb-curated/03a1e7c7-9b85-58fb-aa77-08ac74e8486a.md'],
      notes:
        "Definition-style paraphrase avoiding the phrase 'hash chain'. Gold 'Hash-Chain Audit Log' HIT at rank 1 (0.97) — succeeds because the paraphrase reuses the doc's own body wording (high term overlap).",
    },
    {
      id: 'q22',
      kind: 'semantic',
      query: 'deny access by default unless explicitly approved',
      relevant: ['qmd://kb-curated/bb527104-0513-5cc7-a203-88ca53e1f28d.md'],
      notes:
        "Concept paraphrase of Fail-Closed without the term. Gold 'Fail-Closed' HIT at rank 1 (0.96) — near-verbatim body match; the only doc returned.",
    },
    {
      id: 'q23',
      kind: 'semantic',
      query: 'picking one task clearing distractions giving it complete attention',
      relevant: ['qmd://kb-curated/03badc0d-fd42-5f8d-b63b-f074d3d69cd0.md'],
      notes:
        "Paraphrase of Single-Tasking avoiding the compound term. Gold 'Single-Tasking' HIT at rank 1 (0.97) — reuses the doc's body phrasing.",
    },
    {
      id: 'q24',
      kind: 'semantic',
      query:
        'separate the writer database pool from the reader so the verification path cannot write',
      relevant: ['qmd://kb-curated/311c194f-9bd7-534d-9d8a-9c862b3bfbc4.md'],
      notes:
        "Paraphrase of Dual-Pool Postgres avoiding 'dual-pool'. Gold HIT at rank 1 (0.97) — strong body-term overlap; only doc returned.",
    },
    {
      id: 'q25',
      kind: 'semantic',
      query: 'the fastest path when bootstrapping from zero is a linear series of phases',
      relevant: ['qmd://kb-curated/4236510f-d643-5994-8ec5-5b81dd09d4b3.md'],
      notes:
        'Paraphrase of Sequential Phase Execution avoiding the title. Gold HIT at rank 1 (0.97) — reuses body wording.',
    },
    {
      id: 'q26',
      kind: 'semantic',
      query: 'raise alert priority once a failure streak forms',
      relevant: ['qmd://kb-curated/08909f28-291a-5d1b-a867-030f09f6fc03.md'],
      notes:
        'Paraphrase of Consecutive-Failure Escalation avoiding the term. Gold HIT at rank 1 (0.97) — body-phrasing overlap.',
    },
    {
      id: 'q27',
      kind: 'semantic',
      query: 'transforms raw corpus into structured semantic knowledge through defined passes',
      relevant: ['qmd://kb-curated/b1c0e2d7-6fd6-5e65-9cf0-4e94d5bd585e.md'],
      notes:
        'Paraphrase of Knowledge Compilation avoiding the term. Gold HIT at rank 1 (0.97) — reuses body wording; blueprint guides also returned.',
    },
    {
      id: 'q28',
      kind: 'semantic',
      query: 'MCP servers must not accept tokens that were not issued for themselves',
      relevant: ['qmd://kb-curated/2effddb9-ded0-5d50-a16b-c5b1df16b3e3.md'],
      notes:
        "Restatement of the token-passthrough rule without the term. Gold 'Token Passthrough' NOT in top-10 (0 results) — miss even though semantically exact; token co-occurrence fails under strict-AND.",
    },
    {
      id: 'q29',
      kind: 'semantic',
      query: 'sort tasks by urgency to reduce stress from an overloaded schedule',
      relevant: ['qmd://kb-curated/d5344eaa-1afa-5737-8c9e-a7c954814050.md'],
      notes:
        "Paraphrase of Triage avoiding the word 'triage'. Curated gold 'Triage' NOT in top-10 — a 'Primer' guide (not the gold) returned instead; miss on the concept doc.",
    },
    {
      id: 'q30',
      kind: 'semantic',
      query: 'route cheap simple requests to a free local model and hard ones to a paid cloud API',
      relevant: ['qmd://kb-curated/c55559d7-e5fe-5f25-bc12-49b733d5b80a.md'],
      notes:
        'Paraphrase of the Hybrid AI Stack routing idea, no headline term. Curated gold NOT in top-10 — only an archive open-question doc (out of default scope) returned; miss.',
    },
    {
      id: 'q31',
      kind: 'semantic',
      query: 'use real database containers in tests instead of mocks to catch production bugs',
      relevant: ['qmd://kb-curated/32743115-7333-5076-9143-c997fb662faf.md'],
      notes:
        'Paraphrase of Testcontainers-Based Testing avoiding the term. Curated gold NOT in top-10 — a related blog guide returned instead; miss on the concept doc.',
    },
    {
      id: 'q32',
      kind: 'semantic',
      query:
        'give each dashboard panel its own error boundary so one crash does not blank the page',
      relevant: ['qmd://kb-curated/f32f7ee1-c295-50bd-a837-49e98e4e643a.md'],
      notes:
        "Paraphrase of Per-Panel Error Boundaries reusing some body words. Gold NOT in top-10 (0 results) — BM25 miss; the query's token set never fully co-occurs.",
    },
    {
      id: 'q33',
      kind: 'semantic',
      query: 'the pipeline executes a misread specification perfectly and ships the wrong product',
      relevant: [
        'qmd://kb-guides/1d74a14d-4cd3-4493-9526-f4d3a182979d.md',
        'qmd://kb-curated/75620fd4-eb23-5c6b-a57e-f480a5611bb2.md',
      ],
      notes:
        "Paraphrase of Requirements-Level Error Amplification. Guide gold 'The Wrong Product, Built Perfectly' HIT at rank 1 (0.97); the curated concept doc 'Requirements-Level Error Amplification' did NOT appear (partial hit — one of two golds retrieved).",
    },
    {
      id: 'q34',
      kind: 'semantic',
      query:
        'two environment variables must both be set before an expensive or dangerous operation runs',
      relevant: ['qmd://kb-curated/7e789883-2c59-5b0d-9117-57746de98acc.md'],
      notes:
        'Paraphrase of the Double-Gate Pattern avoiding the term. Gold NOT in top-10 (0 results) — BM25 miss.',
    },
    {
      id: 'q35',
      kind: 'semantic',
      query: 'search the brain before saving because it only dedupes at promotion not intake',
      relevant: ['qmd://kb-curated/3fc61a8d-4f89-5c05-aaa5-925bfb3710b0.md'],
      notes:
        'Paraphrase of the search-before-save memory rule reusing body concepts. Gold NOT in top-10 (0 results) — BM25 miss; tokens do not fully co-occur in one doc.',
    },
    {
      id: 'q36',
      kind: 'semantic',
      query: 'teammates reach one shared brain over the network instead of each running their own',
      relevant: ['qmd://kb-curated/03e26e71-27ee-5975-81f3-badbb273894b.md'],
      notes:
        'Plain-language paraphrase of team-mode / shared-remote-brain. Gold NOT in top-10 (0 results) — BM25 miss on the team-mode doc.',
    },
    {
      id: 'q37',
      kind: 'semantic',
      query:
        'reducing the available tool set from twenty to four or five based on the current context',
      relevant: ['qmd://kb-curated/aa69b924-73ca-5f30-92fa-779da6f0dacb.md'],
      notes:
        'Paraphrase of Contextual Tool Narrowing reusing body numbers. Gold NOT in top-10 (0 results) — BM25 miss despite high semantic match.',
    },
    {
      id: 'q38',
      kind: 'semantic',
      query:
        'separate the build environment from the runtime environment to reduce the final image size',
      relevant: ['qmd://kb-curated/016efea4-8115-56df-80b6-2127a07a298f.md'],
      notes:
        "Paraphrase of Multi-Stage Docker Build avoiding 'multi-stage'. Gold HIT at rank 1 (0.97) — reuses body wording closely.",
    },
    {
      id: 'q39',
      kind: 'semantic',
      query: 'the moat is deterministic governance and receipts not better recall',
      relevant: ['qmd://kb-decisions/45fcbe44-972f-5a3e-9c7b-00d03dc66beb.md'],
      notes:
        'Paraphrase of the Governed-Memory positioning decision. Gold (a kb-decisions doc) NOT in top-10 (0 results) — BM25 miss; also exercises the decisions collection.',
    },
    {
      id: 'q40',
      kind: 'semantic',
      query:
        'each stage returns a new model via model_copy update rather than mutating the original',
      relevant: ['qmd://kb-curated/f9f16dc2-ad20-5ae2-8e7c-058a87daba66.md'],
      notes:
        "Paraphrase of the Immutable Lead Model reusing near-verbatim body wording. Gold NOT in top-10 (0 results) — BM25 miss; 'model_copy' underscore token plus others fail to co-occur.",
    },
    {
      id: 'q41',
      kind: 'semantic',
      query: 'member proposes and the server disposes with a remote proxy over the tailnet',
      relevant: ['qmd://kb-curated/03e26e71-27ee-5975-81f3-badbb273894b.md'],
      notes:
        'Paraphrase of team-mode governance (member-proposes/server-disposes). Gold NOT in top-10 (0 results) — BM25 miss.',
    },
    {
      id: 'q42',
      kind: 'semantic',
      query: 'the brain does not dedupe at intake only promotion dedupes so search before you save',
      relevant: ['qmd://kb-curated/3fc61a8d-4f89-5c05-aaa5-925bfb3710b0.md'],
      notes:
        "Alternate paraphrase of the same intake-dedupe rule as q35, closer to the body wording. Gold NOT in top-10 (0 results) — BM25 miss; shows even body-close rewording can fail under strict-AND when a token (e.g. 'intake') pairing is sparse.",
    },
  ],
};
