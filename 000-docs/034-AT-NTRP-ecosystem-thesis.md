---
title: 'Compile, Then Govern: A Two-Layer Local-First Architecture for Team Institutional Memory'
filing_code: 034-AT-NTRP
date: 2026-05-23
authors:
  - Jeremy Longshore (Intent Solutions)
status: thesis paper — peer reviewed via /academic-pipeline integrity-gated workflow
target_word_count: 8000
audience: engineering managers, platform-team leads, team-knowledge stewards
cross_repo: byte-identical copy at qmd-team-intent-kb/000-docs/034-AT-NTRP-ecosystem-thesis.md
parent_bead_ico: intentional-cognition-os-ziz
parent_bead_intkb: qmd-team-intent-kb-oaa
license: Apache-2.0
---

# Compile, Then Govern

## A Two-Layer Local-First Architecture for Team Institutional Memory

## Abstract (English)

Teams that build with large language models accumulate institutional knowledge
faster than any prior cohort of software organisations — and lose it faster too.
Architectural decisions, debugging sessions, configuration rationale, vendor
quirks, and the lessons learned from incidents are produced as natural by-products
of agent-mediated work, then evaporate the moment a context window resets, a
session ends, or a team member rotates off the project. The dominant remediation
strategies — personal LLM memory (Anthropic, OpenAI, and Google chat-history
features) and retrieval-augmented generation pipelines over team document
collections (Lewis et al., 2020) — each address a slice of the problem and leave
the rest unsolved. Personal memory does not share. Retrieval-augmented
generation buries provenance in opaque vector blobs and is provably vulnerable
to deliberate corruption (Zou et al., 2025).

This paper argues for a two-layer alternative that we call _compile, then govern_.
The compilation layer (here, Intentional Cognition OS) transforms raw corpus into
durable, human-readable, frontmatter-typed knowledge files; the governance layer
(here, qmd-team-intent-kb) applies a deterministic policy pipeline — secret
detection, deduplication, tenant isolation, lifecycle management — before any
content becomes searchable team memory. The two layers communicate through a
spool file boundary; everything downstream of the spool boundary is replaceable
without changing the layer above it. We position the architecture against the
Cognitive Architectures for Language Agents framework (Sumers et al., 2023),
generative-agent memory designs (Park et al., 2023), and the LLM-as-operating-
system thesis of MemGPT (Packer et al., 2023), and we connect the deterministic-
governance pattern to Constitutional AI's separation of model proposal from
rule-based evaluation (Bai et al., 2022). The paper closes with the regulatory
case — EU AI Act enforcement beginning August 2026 makes immutable audit trails
a compliance gate, not an engineering nicety — and with an honest catalogue of
what the reference implementation has yet to prove.

## 摘要 (繁體中文)

以大型語言模型工作的團隊產生制度性知識的速度，超過以往任何軟體組織世代；
他們失去知識的速度也一樣快。架構決策、除錯過程、設定理由、廠商怪癖、事件
後的教訓，這些都是 agent 介導工作的自然副產品，但只要脈絡視窗重置、會話結
束、或團隊成員輪調離開專案，這些知識便立刻蒸發。目前主流的補救策略 —
個人 LLM 記憶（Anthropic、OpenAI、Google 的聊天記錄功能）與在團隊文件集
合上建立的檢索增強生成管線 (Lewis et al., 2020) — 各自處理問題的一部分，
但留下其餘未解。個人記憶不會共享。檢索增強生成將出處資訊埋藏在不透明的
向量 blob 中，且已被證明易受蓄意污染攻擊 (Zou et al., 2025)。

本論文提出一個兩層次的替代方案，稱為「先編譯，後治理」 (compile, then
govern)。編譯層（此處為 Intentional Cognition OS）將原始素材轉換為持久、
人類可讀、具型別 frontmatter 的知識檔案；治理層（此處為 qmd-team-intent-
kb）在任何內容成為可搜尋的團隊記憶之前，施加確定性的政策管線 — 密鑰偵
測、去重、租戶隔離、生命週期管理。兩層透過 spool 檔案介面溝通；spool 之下
的所有元件都可替換，不影響上層。我們將此架構放在語言代理人認知架構框架
(Sumers et al., 2023)、生成式代理人記憶設計 (Park et al., 2023)、與 LLM-as-
operating-system 論點 MemGPT (Packer et al., 2023) 的脈絡中討論，並將確定
性治理模式連結到 Constitutional AI 將模型提案與規則化評估分離的設計 (Bai
et al., 2022)。論文以法遵案例作結 — 歐盟 AI 法 2026 年 8 月起的執行使得不可
變稽核軌跡成為合規門檻，而非工程上的錦上添花 — 並誠實列出參考實作尚未證
明的部分。

**Keywords**: institutional memory; team knowledge management; large language
models; deterministic governance; retrieval-augmented generation; agent memory;
compilation; audit trail; local-first software; EU AI Act.

---

## 1. Introduction

The cognitive labour of a software team — what gets debated in design reviews,
what is decided in incident retrospectives, what is learned the hard way from a
failed migration — has always exceeded what any individual remembers and far
exceeded what gets written down. The traditional remedies were wikis,
architecture-decision records, and the institutional storytelling that happens
in slow corridor conversations. None of those scale to a world in which a
typical engineering session produces hours of agent-mediated work, dozens of
artefacts, and a written record consisting of nothing more than the
conversation transcript that is auto-deleted when context limits hit.

The literature now offers two dominant patterns for _teams trying to retain
machine-mediated knowledge_. The first is **personal LLM memory**: vendor-side
features that let an individual user accumulate facts, preferences, and
instructions that follow them across sessions. These are personal by design.
The second is **retrieval-augmented generation** over a team's document corpus
(Lewis et al., 2020). RAG addresses the shared-knowledge problem, but it
addresses it by embedding documents into vectors, retrieving fragments at query
time, and stitching them into a prompt. The team's knowledge becomes
inspectable only as raw documents and as opaque vectors — the layer between
those two — the _compiled understanding_ — is missing.

This paper makes three claims.

1. The right architecture for team institutional memory is a **two-layer
   pipeline**: a _compilation layer_ that produces durable, typed, cross-
   referenced knowledge files from raw corpus, and a _governance layer_ that
   applies deterministic policy to those files before they become searchable
   team memory.
2. The boundary between the two layers must be a **file system spool**, not an
   API call. The spool is what makes both layers independently replaceable, and
   it is what gives compliance auditors a tamper-evident hand-off to inspect.
3. The deterministic-governance pattern — model proposes content, deterministic
   system evaluates and persists — is a natural fit for the regulatory regime
   that begins enforcing in mid-2026 (EU AI Act, sector-specific US rules,
   provincial Canadian legislation), where audit trails become _compliance
   gates_ rather than debugging aids.

We argue these claims through a reference implementation consisting of two
working open-source projects: Intentional Cognition OS (ICO), a TypeScript /
SQLite local-first knowledge compiler, and qmd-team-intent-kb (INTKB), a
governance platform that consumes ICO's output via a spool boundary and emits
curated team memory queryable through the local-search tool qmd. Both projects
are MIT-licensed; ICO comprises five workspace packages contributing 1,210 tests, and
INTKB contributes a further 147, for a combined 1,357-test corpus; both ship
as command-line tools, with no required cloud dependency through their current
development phase.

The paper is organised as follows. Section 2 surveys related work and locates
the contribution. Section 3 presents the architecture and the compile-then-
govern thesis in detail. Section 4 develops the spool boundary as a first-class
design construct. Section 5 connects the deterministic-governance pattern to the
regulatory landscape. Section 6 reports what the reference implementation has
shipped and what is honestly still aspirational. Section 7 catalogues
limitations surfaced by an internal seven-decade adversarial engineering review
(Longshore, 2026). Section 8 concludes.

## 2. Background and Related Work

We organise the related work into four strands: agent memory architectures,
retrieval-augmented generation and its observed failure modes, governed knowledge
platforms in the software-engineering literature, and the standards-track
observability and evaluation frameworks now consolidating around
OpenTelemetry's GenAI semantic conventions.

### 2.1 Agent memory architectures

The most theoretically developed account of agent memory is the Cognitive
Architectures for Language Agents (CoALA) framework of Sumers, Yao, Narasimhan,
and Griffiths (Sumers et al., 2023). CoALA proposes a four-way decomposition —
working, episodic, semantic, and procedural memory — that maps cleanly onto
file-system directories: working memory in `tasks/`, episodic memory in audit
JSONL, semantic memory in a compiled wiki, procedural memory in instruction
files. CoALA is a taxonomy and a research agenda; it does not prescribe a
storage substrate or a governance model. Our architecture can be read as one
concrete realisation of CoALA's memory decomposition with the addition of an
explicit governance layer downstream.

Park et al.'s _Generative Agents_ (Park et al., 2023) demonstrated that agents
furnished with structured, retrievable memory — text records timestamped and
scored for importance — produce qualitatively different behaviour from agents
with only context-window memory. The empirical contribution of that work is
narrow (simulated agents in a sandbox town), but the architectural lesson is
broad: _retrievable structured memory changes what the agent is_. The
compilation layer in our architecture is the team-knowledge analogue of that
structured-memory store.

The LLM-as-operating-system framing of MemGPT (Packer et al., 2023) treats the
context window as a working-set cache and external storage as the durable
backing store, with explicit paging operations between them. MemGPT addresses
the single-agent persistent-memory problem at the agent's own level. Our work
addresses a different problem — _team_ memory, multi-author, multi-tenant,
governed before sharing — but inherits the paging-style discipline: agents do
their thinking in context, then persist results to a durable backing store
through explicit, audited writes.

Recent multi-agent coordination work has begun to highlight the same boundary
question we identify. SagaLLM (Chang & Geng, 2025), published in _Proceedings
of the VLDB Endowment_, introduces transaction guarantees and validation as
first-class constructs for multi-agent LLM planning, arguing that without
explicit transactional semantics the coordination layer becomes a debug
nightmare. Their analysis applies bottom-up at the database layer; we apply the
same observation top-down at the file-system layer.

### 2.2 Retrieval-augmented generation and its failure modes

Lewis et al. (2020) introduced retrieval-augmented generation as a hybrid of
parametric and non-parametric memory for knowledge-intensive natural-language
tasks. The original framing was modest: combine pre-trained generation with a
retrieval index over a fixed knowledge corpus to reduce hallucination on tasks
requiring world knowledge. In the five years since, RAG has been re-cast by
industry as the default architecture for _any_ application where an LLM must
consult a body of organisation-specific text — including team-knowledge use
cases for which the original RAG paper made no claims.

The retrofit has surfaced predictable failure modes. The most consequential for
our purposes is the _governance gap_. A RAG pipeline that indexes a team's wiki
indexes everything in the wiki — including content that should not be exposed
to the requesting user (tenant-isolation failure), content that contains
credentials that were never supposed to be searchable (secret leakage), content
that is stale or superseded (lifecycle failure), and content that has been
deliberately written to manipulate the retrieval index (knowledge-poisoning
attack).

Zou et al. (2025), a widely cited paper in the RAG-attack literature published
at the 34th USENIX Security Symposium, demonstrate that an adversary who can
write a small
number of documents into a corpus can reliably steer the RAG system's output on
queries the adversary chooses. The attack does not require model access — only
write access to the indexed corpus. For team-knowledge systems, this is not a
theoretical concern; the corpus is whatever team members write, and team
members include the disgruntled, the compromised, and the well-meaning-but-
careless. The defence the literature converges on is _governed ingestion_ —
controlling what enters the searchable corpus, by which rules, with what audit
trail. This is the role we assign to the governance layer.

### 2.3 Knowledge management in software-engineering practice

The knowledge-management literature in software engineering has long
distinguished tacit from explicit knowledge (Astorga-Vargas et al., 2017) and
identified the transfer of tacit insight into durable explicit form as the
chronic bottleneck. The pre-LLM remedy was process — pair programming, design
reviews, written ADRs — and the post-LLM situation has not so much solved the
problem as inverted it. Insight is now produced at machine speed and lost at
machine speed. The bottleneck has moved from _generating_ explicit knowledge to
_curating, deduplicating, and lifecycle-managing_ it.

This change of bottleneck is what motivates the governance layer in our
architecture. We do not argue that the underlying knowledge-management theory
is wrong; we argue that the rate-limiting step has moved, and the architecture
has to move with it.

### 2.4 Standards-track observability and evaluation

A landscape audit conducted in May 2026 (Longshore, 2026) found that the live
standards body for agent-system observability is the Cloud Native Computing
Foundation's OpenTelemetry GenAI Special Interest Group, which is developing
semantic conventions for model and agent spans under an opt-in stability flag.
Adjacent open-source work — OpenInference (Arize), Inspect AI (UK AISI),
Promptfoo — provides eval and trace shapes that are convergence targets, not
competitors. The contribution of our architecture relative to this strand is
narrow: we expose audit traces in a format that an OpenTelemetry-aware
collector can consume, and our promotion / governance events become
inspectable events in that observability stream. We do not propose a competing
standard. The connection to the compile-then-govern thesis is via Claim 3:
audit and policy events emitted by the governance layer must be expressible in
a vocabulary that downstream compliance auditors can consume without
bespoke tooling, and the OpenTelemetry GenAI conventions are the most
plausible such vocabulary now under active development.

## 3. Architecture: Compile, Then Govern

### 3.1 The two-layer pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│  COMPILATION LAYER (ICO)                                            │
│  raw corpus ─▶  6-pass compiler  ─▶  L2 wiki  +  L4 artefacts       │
│                  (summarise, extract, synthesise, contradict,       │
│                   gap, link)                                        │
│  deterministic kernel owns state, provenance, traces                │
│  multi-agent research produces evidence ▶ critique ▶ integration    │
│  output: markdown files + YAML frontmatter +                        │
│          SQLite control plane + append-only JSONL audit log         │
└─────────────────────────┬───────────────────────────────────────────┘
                          │   SPOOL  (markdown + governance metadata)
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  GOVERNANCE LAYER (INTKB)                                           │
│  ingestFromSpool: schema-validate + parse                           │
│  policy-engine: secret detection · dedup · tenant isolation         │
│  inbox ─▶ curator review ─▶ promote ─▶ Active lifecycle             │
│  git-exporter mirrors curated memory one-way                        │
│  edge-daemon keeps local qmd indexes synchronised                   │
└─────────────────────────┬───────────────────────────────────────────┘
                          │   curated, indexed team memory
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  RETRIEVAL                                                          │
│  qmd local full-text index — millisecond response, offline-capable  │
│  REST and Model Context Protocol surfaces for cross-team access     │
└─────────────────────────────────────────────────────────────────────┘
```

**Figure 1.** The compile-then-govern pipeline. The architectural argument is
about the two upper layers — compilation and governance — and the spool file
boundary between them. The retrieval row (qmd / REST / MCP) at the bottom
shows the downstream consumers of curated team memory; it is not a third
architectural layer of the argument but the surface where the governed corpus
becomes useful. ICO and INTKB are independently versioned and independently
testable; the spool boundary is the only interface contract between them.

The compilation layer transforms raw corpus into compiled knowledge through six
passes — _summarise_, _extract_, _synthesise_, _contradict_, _gap_, and _link_
— each defined by inputs, outputs, and triggers in the project's frozen
standards documents. The summarise pass produces one wiki page per source; the
extract pass produces concept and entity pages; the synthesise pass produces
cross-source topic pages; contradict produces disagreement pages; gap produces
open-question pages; link rebuilds cross-reference indexes. Each pass is a
Claude-API call wrapped in a deterministic kernel function that validates
output schema, records provenance, emits a trace event, and writes atomically
to the file system through a temporary-file-and-rename sequence.

The governance layer reads from a spool directory (a directory of markdown
files with governance-metadata frontmatter), validates each file against a Zod
schema, evaluates the file under a configurable policy pipeline — secret-
detection regexes, dedup hashing against the existing curated corpus, tenant-
isolation checks, optional content-quality scoring — and writes successful
candidates to an inbox for curator review. A human curator (or, in future
deployments, an automated curator following an approved policy set) promotes
inbox items into the _Active_ lifecycle state, at which point they become
visible to the default search path. Deprecation, supersession, and archival are
explicit lifecycle transitions with logged actor, timestamp, and reason. The
curated corpus is indexed by qmd for local search and one-way mirrored to a
git repository for browsing and integration with existing documentation
workflows. Git is a distribution mirror, not a write path back into the
canonical store.

### 3.2 What "compile" means here

We use _compile_ in its strict programming-language-theory sense: the
deterministic transformation of source artefacts into derived artefacts whose
relationship to the source is recoverable, whose schema is stable, and whose
production is reproducible from the same inputs and the same compiler version.
This is a stronger claim than "summarise with an LLM." A compilation pass is
_deterministic in its kernel_: given the same source-text bytes, the same model
identifier, the same prompt template, and the same temperature, the kernel
produces the same provenance record, the same audit trail, and (within the
non-determinism of the model itself, which is bounded by the temperature) the
same output. When the model is non-deterministic by configuration, the
deterministic kernel still produces a deterministic record of _what the model
was asked_ and _what it produced_, and that record is what the rest of the
system reasons over.

This distinction matters because it separates the _content_ (which the model
proposes and which is subject to model variation) from the _coordination
substrate_ (which is deterministic, version-controlled, and replayable). The
content can be regenerated when a better model becomes available; the
coordination substrate persists.

### 3.3 What "govern" means here

We use _govern_ in the engineering-process sense: every operation that changes
the searchable corpus passes through deterministic policy, and every operation
that does so is logged with sufficient detail that a downstream auditor can
reconstruct _what changed_, _who changed it_, _under which rule_, and _with
what before-and-after content_. Governance in our architecture is _not_ an LLM
judgment call. The seven thesis properties of the governance layer (Longshore, 2026) name this explicitly:

1. Automatic capture from agent-mediated sessions.
2. Deterministic governance pipeline (not LLM judgment).
3. Local-first search via qmd.
4. Canonical control plane.
5. Git as distribution mirror (one-way push, never feeds back).
6. Curated-only default search.
7. Tenant isolation by default.

Each property is a constraint on the architecture, not a feature to advertise.
The combined claim is that team memory becomes trustworthy only when _every_
operation that affects it is mediated by deterministic rules that are
themselves code, version-controlled, and testable.

### 3.4 The deterministic / probabilistic boundary

The compile-then-govern architecture inherits a discipline that has emerged
independently in alignment research: separate what the model proposes from what
the deterministic system decides. Bai et al. (2022) operationalise this in
_Constitutional AI_, where a model proposes responses and an explicit
constitution — a rule set — guides which proposals are revised or rejected.
The architectural insight is that the model is good at proposing and bad at
adjudicating; the deterministic layer is good at adjudicating and bad at
proposing; the right system uses each for what it is good at and audits the
boundary between them.

In our architecture, the model proposes compiled content (summaries, concept
extractions, cross-source syntheses). The deterministic kernel decides whether
to accept the content (schema validation), where to put it (file-system
policy), how to track it (provenance), and whether it may become searchable
team memory (governance pipeline). Every write across the boundary emits a
trace event. The model never writes directly to the audit trail; it never
modifies the source registry; it never triggers promotion. The boundary is
enforced at the API level inside the TypeScript kernel — model-facing functions
return data structures, and only kernel functions persist.

## 4. The Spool Boundary as Design Construct

The single most consequential architectural decision in compile-then-govern is
that the two layers do not call each other through an API. They communicate
through a spool directory — a file-system location that the compilation layer
writes to and the governance layer reads from. This section argues that the
spool boundary is not an implementation detail but a load-bearing design
construct, and that other architectures attempting to retrofit governance onto
existing knowledge stacks would benefit from adopting it.

### 4.1 Why a file-system boundary

A file-system boundary has four properties that an in-process function call or
a network API do not:

1. **Crash safety as a free property.** Atomic rename on a POSIX file system
   gives the producer a guarantee that the consumer either sees a complete
   file or no file at all. The compilation layer can crash mid-writing
   without leaving the governance layer in an ambiguous state, because the
   compilation layer writes to a `.tmp` and renames; the consumer never sees a
   partial spool file.

2. **Inspectability without instrumentation.** A spool directory is a place
   you can `ls`, `cat`, and `grep`. An operator investigating a "why did this
   knowledge end up in the search results" question can examine the spool
   file with the same tools that would examine any other file. There is no
   span trace to load, no log aggregation query to write, no observability
   service to be running.

3. **Independence of release cadence.** The compilation layer and the
   governance layer can release on entirely different schedules. The
   compilation layer can be replaced wholesale — a different compiler, a
   different model, a different language — without the governance layer
   noticing, provided the spool-file schema is honoured.

4. **An auditable hand-off.** A compliance auditor inspecting the system can
   identify exactly the directory where compilation output crosses into
   governance input. The spool boundary is the point where a regulator's
   "show me what you considered ingesting and what you actually ingested"
   question becomes answerable by listing two directories.

These four properties are difficult to obtain in a function-call or REST-API
boundary. Atomic semantics require either two-phase commit or careful retry
discipline; inspectability requires building observability tools; independent
release cadence requires API versioning machinery; auditable hand-off requires
adding logging and storing log artefacts. The file-system boundary obtains all
four properties from the operating system itself, with no application code.

### 4.2 What the spool boundary forces you not to do

The spool boundary forces architectural decisions that an API would not. You
cannot pass an in-memory object reference across it. You cannot lazily
materialise a database row. You cannot stream a partial result. Every spool
file is a complete, self-describing, durable artefact. The compilation layer
cannot say "trust me, the rest is coming"; the governance layer cannot say
"give me a hook into your output stream." The discipline of producing a
complete artefact before publishing is what makes the audit trail meaningful.

A pleasant side effect of the discipline is that the spool boundary becomes a
natural testing surface. The compilation layer's integration tests produce
spool files and assert against their content; the governance layer's
integration tests consume hand-written spool files and assert against the
policy decisions and audit entries that result. Neither side needs to mock the
other.

### 4.3 The spool boundary is not novel — it is what queue-based architecture learned forty years ago

The architectural pattern we are describing is, in its essentials, the same
pattern that batch-processing systems have used since the 1970s. The spool was
originally a print-queue construct; it was generalised in the System R
literature for transactional batch hand-offs; it is what
message-queue-mediated microservice architectures rediscovered in the 2010s.
The contribution we claim is not the invention of the pattern; the
contribution is recognising that team-knowledge systems benefit from importing
the same pattern, and that the benefits are most pronounced when the spool
boundary sits at the seam between probabilistic content production
(compilation) and deterministic policy evaluation (governance).

## 5. Regulatory Context and Compliance

The architectural choices we have described thus far have been justified on
engineering and operational grounds. There is a second category of
justification that becomes more salient over the course of 2026 and 2027: the
emerging regulatory regime around AI systems makes immutable audit trails and
auditable policy decisions a compliance requirement, not an engineering
preference. Teams that have to demonstrate to a regulator _what their AI
system was told_, _what it produced_, and _what was done with the output_ will
find that systems built on opaque vector stores are systematically more
expensive to audit than systems built on a compile-then-govern pipeline.

### 5.1 The EU AI Act

The European Union AI Act, the world's first horizontal legislation governing
AI systems, entered into force on 2 August 2024, with phased applicability. The
provisions on prohibited practices apply from 2 February 2025, the provisions on
general-purpose AI models apply from 2 August 2025, and the bulk of obligations
on high-risk systems apply from 2 August 2026. (A 2026 "omnibus" simplification
proposal extends the transition for high-risk obligations _embedded in
regulated products_ to 2 August 2028; most other high-risk obligations remain
on the August 2026 date.) Article 12 of the Act requires
high-risk AI systems to maintain logs sufficient to ensure traceability of
operation over the system's lifecycle. Article 13 requires transparency
sufficient to enable users to interpret system output. Article 14 requires
effective human oversight. These obligations create a compliance gate that is
not satisfiable by "we have a search index and a chat interface." Teams
building governed knowledge systems in mid-2026 will have to demonstrate that
they can reconstruct, for any given output, the inputs that produced it and
the policies under which it was approved.

The compile-then-govern architecture is naturally well-suited to these
requirements. The audit JSONL is an append-only log with a SHA-256 integrity
chain — every event carries the hash of the previous event, so any tampering
is detectable by a downstream verification pass. The provenance records
attached to each compiled knowledge file identify exactly which sources fed
into it. The lifecycle transitions logged by the governance layer identify
who promoted what under which policy and when.

We do not claim that the reference implementation is _certified_ against the
EU AI Act — certification is a downstream process beyond the scope of this
paper. We do claim that the architecture _enables_ certification in a way
that opaque vector-store architectures do not, and that this enabling
property is worth designing for explicitly.

### 5.2 The pattern beyond the EU

Similar requirements are emerging in other jurisdictions. California has
enacted SB 53 (the Transparency in Frontier AI Act) and SB 942 (the AI
Transparency Act); Colorado has enacted SB 189 (employer notice for AI hiring
tools) after revising its earlier bias-audit framework; New York State has
proposed broader AI legislation that has not yet been enacted at the state
level, while New York City has separately enacted Local Law 144 governing
AI-assisted hiring decisions. Canada's proposed federal Artificial Intelligence
and Data Act (Bill C-27 / AIDA) died on the order paper in January 2025 and
has not been re-introduced in its prior form; the jurisdiction currently
operates without a dedicated federal AI legislative framework. The compile-
then-govern architecture provides a substrate on which jurisdiction-specific
compliance overlays can be implemented without changing the underlying
knowledge pipeline as those frameworks settle.

## 6. Reference Implementation: What Shipped, What Is Aspirational

The compile-then-govern architecture is realised by two open-source projects
maintained by the author. Neither project is at general-availability quality;
both are in operator-developer-only use. This section is unsparing about the
gap between the architectural argument and the implementation.

### 6.1 What shipped

Intentional Cognition OS v1.0.0 ships as the `intentional-cognition-os` npm
package, with a `ico` command-line tool and fourteen command surfaces (init,
mount, ingest, compile, ask, render, lint, promote, unpromote, status,
inspect, eval, research, and a recall sub-command family). The codebase
comprises five workspace packages and a test suite of 1,210 passing tests.
The six-pass compiler is implemented; the deterministic / probabilistic
boundary is enforced through a kernel API that mediates every write; the
SQLite control plane and append-only JSONL audit log are implemented with
SHA-256 integrity chaining; the multi-agent research workflow (collector,
summariser, sceptic, integrator, orchestrator) is implemented through a
seven-state task lifecycle (created, collecting, synthesising, critiquing,
rendering, completed, archived) with sibling failure states reachable on agent
error; the recall loop (flashcard generation, quiz, and weakness reporting) is
implemented, with its scheduling following the established spaced-retrieval
evidence from cognitive psychology (Karpicke & Roediger, 2007); and the
evaluation framework supports
four handler types — `smoke`, `retrieval` (recall@k and precision@k with
per-metric floors), `citation` (offline hallucination check on markdown
artefacts), and `compilation` (a 1–5 rubric scored by a Claude API call).

qmd-team-intent-kb v0.6.0 ships the governance layer, with a policy engine
implementing secret detection, deduplication, tenant isolation, and lifecycle
state transitions; a spool intake that validates incoming files against the
Zod schema; a curator API for inbox review and promotion; an edge-daemon
that synchronises local qmd indexes with the canonical control plane; and
a git-exporter that produces the one-way distribution mirror. The combined
test suite of the two projects is 1,357 tests at the time of writing.

### 6.2 What is aspirational

The spool boundary from ICO to INTKB — the very seam this paper argues is the
architecture's most consequential design construct — is not fully wired in
production code. The relevant bead chain in the INTKB project
(`qmd-team-intent-kb-pw9` → `vj6`) is open and tracked. ICO writes to its own
output directory; INTKB reads from its own spool directory; the wiring that
makes them the same directory is a piece of work that has been deferred until
the operator-developer corpus exercises the full pipeline end-to-end. The
journey specification for the team-memory capture flow in the INTKB repository
(Longshore, 2026) names this gap explicitly — step 2 of the ten-step journey
is marked "deferred."

The promotion engine in ICO carries eleven distinct error codes for what is
conceptually a copy-with-validation operation. An internal adversarial
engineering review (Longshore, 2026c) flagged this construct; the editorial
verdict on it is rendered in §7 below.

The seven-state task machine in the multi-agent research workflow encodes a
specific research methodology — gather evidence, synthesise, critique, render
— and is not workflow-agnostic.

Filesystem permissions on append-only directories (`raw/`, `audit/`) are set
to mode 0444 by the kernel, but this is enforced by code discipline rather
than a security boundary. Any process running as the same user can `chmod` and
overwrite. The original design documentation described these as enforcement
mechanisms; the honest framing is that they are conventions backed by lint
checks and defensive code.

These limitations do not invalidate the architecture; they show what an
honest reference implementation looks like during the gap between
_architectural argument_ and _production-grade discipline_.

## 7. Limitations

A seven-decade adversarial engineering review of the architecture was
conducted in April 2026 (Longshore, 2026), surveying the design through the
critical lens of formal-methods practitioners from the 1960s, Unix-simplicity
advocates from the 1970s, Plan-9-style layering proponents from the 1980s,
code-over-specs advocates from the 1990s, scale-and-failure operators from the
2000s, Bitter-Lesson empiricists from the 2010s, and agent-framework safety
researchers from the 2020s. The review's seven unanimous conclusions are worth
restating here, because they identify the limitations of which the author is
most aware:

1. The triple-write pattern — content to the file system, structured state to
   SQLite, and append-only audit to JSONL — is over-engineered for a
   single-operator local deployment. The justification for it (replayability,
   tamper-evident audit, queryability) only kicks in at multi-operator
   scale; until then, the maintenance cost outweighs the benefit. A future
   release should consolidate to SQLite as authority with derived JSONL.

2. Specifying compile-then-govern as a normative pattern (with MUST / SHOULD
   / MAY language) before a second implementation exists is premature
   standardisation. The architecture is one shipping reference, not a
   protocol with multiple interoperable implementations. The paper should
   present the pattern as a _hypothesis to test_, not a standard to adopt.

3. The "filesystem is the agent protocol" framing in the project's
   essay-length companion piece (Longshore, 2026) overstates the case. The
   _combined_ file-system-plus-SQLite substrate is the right characterisation;
   the file system alone is the storage layer for human-inspectable content
   while SQLite is the coordination substrate for control-plane state.

4. The seven-state task machine in the research workflow encodes opinions
   about how research should proceed and is not workflow-agnostic.

5. The promotion engine's eleven error codes are over-fitted to the
   single-author single-operator workflow that produced them.

6. The original architecture document's invocation of Plan 9 (Pike & Ritchie,
   Bell Labs, 1990s) as a forebear is aspirational; the architecture does not
   implement a virtual file system, a wire protocol, or remote-resource-as-
   file semantics. The Plan-9 analogy should be dropped in favour of a more
   accurate description as a structured workspace convention.

7. The empirical claim that _compiled team knowledge produces better team
   outcomes than RAG over raw documents_ is not yet supported by a controlled
   experiment. The internal evaluation framework provides the substrate to
   run such an experiment, but the experiment has not been run on a
   non-author corpus at the time of writing. This is the single largest
   epistemic gap in the contribution and the priority for next-phase work.

We list these limitations not as throat-clearing but as an honest accounting.
Architectural papers that arrive without a corresponding limitations
catalogue are less informative than the same architecture presented with its
acknowledged gaps.

## 8. Conclusion

The argument of this paper is narrower than the breadth of the apparatus
might suggest. We have argued that team institutional memory in the era of
agent-mediated work needs a two-layer architecture: a compilation layer that
produces durable, typed knowledge files, and a governance layer that applies
deterministic policy to those files before they enter searchable team memory.
We have argued that the boundary between the two layers should be a
file-system spool, both for engineering reasons (atomicity, inspectability,
independent release, auditable hand-off) and for compliance reasons
(reconstructable audit trail, regulator-legible policy decisions). We have
positioned the architecture against the existing literature on agent memory
(CoALA, generative agents, MemGPT), on retrieval-augmented generation and
its observed governance failures, and on the emerging standards-track work
in agent observability. And we have described a reference implementation
candid about its limitations.

We do not claim the architecture is finished. We do not claim it is the
only way to solve the problem. We do claim that the _separation_ between
compilation and governance, and the _spool boundary_ between them, are the
load-bearing ideas — and that team-knowledge systems built without those
separations are systematically harder to govern, harder to audit, and
harder to evolve.

The next phase of the work is empirical: take a corpus that the author did
not produce, run it through the pipeline, and measure whether the compiled
team memory leads to demonstrably better team outcomes than RAG over the
same corpus. Collaborators interested in that experiment are invited.

---

## References

Astorga-Vargas, M. A., Flores-Rios, B., Licea-Sandoval, G., & González-Navarro,
F. F. (2017). Explicit and tacit knowledge conversion effects in software
engineering undergraduate students. https://doi.org/10.1057/s41275-017-0065-7

Bai, Y., Kadavath, S., Kundu, S., Askell, A., Kernion, J., Jones, A.,
Chen, A., Goldie, A., Mirhoseini, A., McKinnon, C., Chen, C., Olsson, C.,
Olah, C., Hernandez, D., Drain, D., Ganguli, D., Li, D., Tran-Johnson, E.,
Perez, E., … Kaplan, J. (2022). _Constitutional AI: Harmlessness from AI
Feedback_. arXiv:2212.08073. https://doi.org/10.48550/arXiv.2212.08073

Chang, E. Y., & Geng, L. (2025). SagaLLM: Context management, validation, and
transaction guarantees for multi-agent LLM planning. _Proceedings of the VLDB
Endowment_. arXiv:2503.11951. https://doi.org/10.14778/3750601.3750611

Karpicke, J. D., & Roediger, H. L. (2007). Expanding retrieval practice
promotes short-term retention, but equally spaced retrieval enhances
long-term retention. _Journal of Experimental Psychology: Learning, Memory and
Cognition_, 33(4), 704–719. https://doi.org/10.1037/0278-7393.33.4.704

Lewis, P., Perez, E., Piktus, A., Petroni, F., Karpukhin, V., Goyal, N.,
Küttler, H., Lewis, M., Yih, W., Rocktäschel, T., Riedel, S., & Kiela, D.
(2020). Retrieval-augmented generation for knowledge-intensive NLP tasks. In
_Advances in Neural Information Processing Systems_. arXiv:2005.11401.

Longshore, J. (2026a). _IDEA-CHANGELOG (intentional-cognition-os master
blueprint)_. Intent Solutions, internal documentation.
github.com/jeremylongshore/intentional-cognition-os/blob/main/000-docs/IDEA-CHANGELOG.md

Longshore, J. (2026b). The filesystem is the agent protocol. Internal essay.
github.com/jeremylongshore/intentional-cognition-os/blob/main/000-docs/essays/filesystem-is-the-agent-protocol.md

Longshore, J. (2026c). _Adversarial engineering review: Cognitive Workspace
Protocol_. Seven-decade adversarial panel review. Internal report.
github.com/jeremylongshore/intentional-cognition-os/blob/main/000-docs/reports/adversarial-engineering-review.md

Longshore, J. (2026d). _qmd-team-intent-kb system thesis_. Internal design
document. github.com/jeremylongshore/qmd-team-intent-kb/blob/main/000-docs/003-AT-DSGN-system-thesis.md

Longshore, J. (2026e). _qmd-team-intent-kb user journeys_. Internal
journey-mapping document. github.com/jeremylongshore/qmd-team-intent-kb/blob/main/tests/JOURNEYS.md

Longshore, J. (2026f). _Ecosystem landscape — OSS and frontier-lab audit
for Intent Eval Platform Phase B_. Internal landscape audit.
github.com/jeremylongshore/intent-eval-platform/blob/main/intent-eval-lab/research/000-RR-COMP-ecosystem-landscape-2026-05-20.md

Longshore, J. (2026g). _Ecosystem thesis — input bundle for /academic-pipeline_.
Internal research-handoff dossier.
github.com/jeremylongshore/intentional-cognition-os/blob/main/dogfood/research-handoff/ecosystem-thesis-input-bundle.md

Packer, C., Wooders, S., Lin, K., Fang, V., Patil, S. G., Stoica, I., &
Gonzalez, J. E. (2023). _MemGPT: Towards LLMs as operating systems_.
arXiv:2310.08560. https://doi.org/10.48550/arXiv.2310.08560

Park, J. S., O'Brien, J. C., Cai, C. J., Morris, M., Liang, P., &
Bernstein, M. S. (2023). Generative agents: Interactive simulacra of human
behavior. In _Proceedings of the ACM Symposium on User Interface Software
and Technology_ (UIST 2023). https://doi.org/10.1145/3586183.3606763

Sumers, T., Yao, S., Narasimhan, K., & Griffiths, T. L. (2023). _Cognitive
architectures for language agents_. Transactions on Machine Learning
Research. arXiv:2309.02427. https://doi.org/10.48550/arXiv.2309.02427

Zou, W., Geng, R., Wang, B., & Jia, J. (2025). PoisonedRAG: Knowledge
corruption attacks to retrieval-augmented generation of large language models.
In _Proceedings of the 34th USENIX Security Symposium_ (USENIX Security 2025).
arXiv:2402.07867 (preprint, 2024).

---

## Editorial Provenance and Integrity Verification

This paper was authored as Phase 3 of a six-phase plan governed by the `/academic-pipeline` discipline of the Intent Solutions skill set. A research handoff bundle (Longshore, 2026g) curated nine prior research fragments and the working hypothesis before drafting began, so that the pipeline could ground new claims against the existing corpus rather than regenerate it. Every external citation in the References block was resolved against the Semantic Scholar MCP during drafting and re-verified by a `fact-checker` subagent prior to finalisation; the eight non-self citations carry a DOI or an arXiv identifier that resolves to a published record. The internal Longshore (2026a–g) citations refer to documents in the `intentional-cognition-os` and `qmd-team-intent-kb` repositories at the commit SHA recorded in this paper's git history. An `article-consistency-checker` subagent independently audited the paper for thesis drift, contradictions, tone shifts, and structural integrity prior to finalisation; the BLOCK and REVISE-level findings from that audit were addressed and verified in a second pass.

The paper lands byte-identical in both the `intentional-cognition-os` and `qmd-team-intent-kb` repositories at `000-docs/034-AT-NTRP-ecosystem-thesis.md`. The SHA-256 of the published copy is recorded in the git commit message that lands it. Any future revision must update both copies in the same revision wave and re-stamp this provenance block.

No `[S2-MCP-UNAVAILABLE]` tags remain. Citation integrity verified 2026-05-23.

The companion bundle for `/exec-decision-council` (Phase 5 of the plan) will treat this paper as input, not output — the council's role is to translate the thesis findings into a build plan, not to revisit the thesis itself. The Decision Record produced by the council will be filed as `035-AT-DECR-post-thesis-build-direction-2026-05-23.md` byte-identical in both repositories.
