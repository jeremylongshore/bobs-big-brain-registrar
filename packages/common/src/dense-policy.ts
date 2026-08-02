/**
 * Serving policy for the dense retrieval arm (bead `compile-then-govern-39z.6`).
 *
 * ## Why this lives in `common` and not in the adapter
 *
 * `QmdAdapterConfig.dense` is deliberately documented as *"Explicit options only
 * — no env magic"*, and that contract is worth keeping: the adapter should do
 * what it is told, so a test or an eval can construct it deterministically.
 *
 * But *whether dense is on in production* is a POLICY decision, not an adapter
 * concern. So the policy is resolved here, at the application edge, and handed
 * to the adapter as explicit options. The adapter contract is unchanged.
 *
 * ## Why it is shared rather than inlined at each call site
 *
 * There are TWO serving paths that must agree — the API's `SearchService` and
 * the plugin's local search path — and bead `qmd-team-intent-kb-vps.1` was
 * closed after exactly this class of bug: the freshness/category rerank had been
 * wired into the API path only, so the plugin (which bypasses the API entirely)
 * silently served un-reranked results. Two call sites configured by hand drift.
 * One helper cannot.
 *
 * ## Why ON by default
 *
 * Measured on the frozen 42-query governed-brain-v1 anchor, full-corpus rebuild
 * 2026-08-01 (registrar PR #318 preserved the index):
 *
 * | stratum  | lexical-only | dense-fused | Δ Recall@10 |
 * |----------|--------------|-------------|-------------|
 * | lexical  | 1.0000       | 1.0000      | +0.0000     |
 * | semantic | 0.3393       | 0.9643      | +0.6250     |
 * | overall  | 0.5595       | 0.9762      | +0.4167     |
 *
 * `ship gate ... PASS`. Overall clears the ADR-038 0.85 gate that the
 * lexical-only arm misses. Interactive latency measured 2026-08-02 over the real
 * 17,289-vector index: **~75 ms median / ~123 ms p95 added** per query (34 ms
 * query-embed + 41 ms sqlite-vec KNN). Both of PR #311's conditions — full-corpus
 * rebuild confirm and interactive latency — are therefore satisfied.
 *
 * ## Why there is still a kill switch
 *
 * The latency number is CPU-contention-sensitive, not load-invariant: the same
 * benchmark under saturation (load 10.96 on 8 cores) measured the query-embed at
 * 758 ms median / 2.2 s p95, a 22x degradation, while the KNN barely moved
 * (index-bound, not CPU-bound). So the risk is real but bounded and operational.
 * `TEAMKB_DENSE=0` turns the arm off without a deploy.
 *
 * Note the arm ALSO fails open inside the adapter: embedder down, index unbuilt,
 * or any query-embed error degrades to the lexical fusion rather than erroring.
 * This switch is for the case where dense is *working* but you want it off.
 *
 * @module dense-policy
 */

/**
 * ⚠️ SERVING ONLY — the eval harness must NOT call `resolveDenseConfig`.
 *
 * `@qmd-team-intent-kb/qmd-adapter` depends on this package, so this helper is
 * *reachable* from the eval code, and it is the obvious thing to reach for. Do
 * not. The retrieval eval deliberately opts into the dense arm with its own
 * switch (`GOVERNED_EVAL_DENSE=1`) and builds its adapter with explicit options
 * (`ci-retrieval-ratchet.ts` constructs `new QmdAdapter({ tenantId, exportDir })`
 * with no `dense` field at all).
 *
 * That separation is load-bearing: the committed anchor floors were measured on
 * the LEXICAL arm. If the eval started resolving its config from the serving
 * policy, flipping `TEAMKB_DENSE` would silently change what the daily timer
 * measures and the floors would no longer describe the thing being gated —
 * either failing the timer nightly or, worse, passing against a stale baseline
 * and silently approving a ranking change nobody reviewed.
 *
 * Serving default and eval default are intentionally allowed to differ. Aligning
 * them is a deliberate change to the floors, not a side effect of an import.
 */

/** Loopback embedding service (`bbb-embedder`, EmbeddingGemma-300M). */
export const DEFAULT_DENSE_EMBED_URL = 'http://127.0.0.1:8098';

/**
 * Measured p95 of the total dense-added latency (query embed + sqlite-vec KNN),
 * 2026-08-02, 40 queries warm against the real 17,289-vector index on a
 * normally-loaded box. Named so the timeout's relationship to it is greppable
 * rather than a frozen literal buried in a test assertion.
 */
export const MEASURED_DENSE_P95_MS = 123;

/** Dense KNN hits fed to the RRF fusion, pre scope-filter. */
export const DEFAULT_DENSE_SEARCH_K = 50;

/**
 * Hard timeout for the query-embed call.
 *
 * 2000 ms is ~16x the measured p95 (123 ms total added) and ~28x the median, so
 * it never trips in normal operation — but it still bounds the pathological
 * contention case rather than letting a search hang on a wedged embedder. The
 * offline eval arm uses a far longer timeout on purpose (a slow embed there is
 * data, not an outage); serving is the opposite and must stay responsive.
 */
export const DEFAULT_DENSE_TIMEOUT_MS = 2000;

/** The explicit dense options handed to `QmdAdapterConfig.dense`. */
export interface DenseServingConfig {
  enabled: boolean;
  url: string;
  searchK: number;
  timeoutMs: number;
}

/** Minimal env shape; callers pass `process.env`. */
export type DensePolicyEnv = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the dense serving policy.
 *
 * Dense is **on by default**. `TEAMKB_DENSE` accepts the usual off-switches
 * (`0`, `false`, `off`, `no`, case-insensitive); anything else — including unset
 * — leaves it on. Parsing is permissive in the OFF direction on purpose: an
 * operator reaching for a kill switch under pressure should not have to
 * remember which spelling the code wanted.
 *
 * `TEAMKB_DENSE_URL` overrides the embedder endpoint. The DEFAULT is loopback —
 * but that is a default, **not a guarantee**. An operator may point the dense arm
 * at a remote embedder, and if they do, **every query's text leaves this host**
 * to be embedded there. Only do that deliberately.
 *
 * Note the embedder service binding loopback-only (`--host 127.0.0.1` in the
 * systemd unit) constrains INBOUND connections and does nothing to constrain
 * this OUTBOUND one — so a mistyped or leaked `TEAMKB_DENSE_URL` is a
 * query-exfiltration channel, not a connection that fails closed. Hence the
 * warning below rather than silent acceptance.
 *
 * A non-loopback override is WARNED, not blocked: blocking would break a
 * legitimate future remote-embedder deployment, while silence would let an
 * accidental override ship unnoticed. Loud-but-permitted is the honest middle.
 *
 * @param env - Environment to read (pass `process.env`).
 * @param warn - Sink for the off-host warning; defaults to stderr. Injectable so
 *               tests assert the warning without capturing global console.
 */
export function resolveDenseConfig(
  env: DensePolicyEnv,
  warn: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
): DenseServingConfig {
  const raw = env['TEAMKB_DENSE']?.trim().toLowerCase();
  const disabled = raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
  const url = env['TEAMKB_DENSE_URL']?.trim() || DEFAULT_DENSE_EMBED_URL;

  if (!disabled && !isLoopbackUrl(url)) {
    warn(
      `[dense] WARNING: TEAMKB_DENSE_URL points off-host (${url}). ` +
        'Every search query will be sent there to be embedded. ' +
        'Set TEAMKB_DENSE=0 to disable the dense arm if this was not intended.',
    );
  }

  return {
    enabled: !disabled,
    url,
    searchK: DEFAULT_DENSE_SEARCH_K,
    timeoutMs: DEFAULT_DENSE_TIMEOUT_MS,
  };
}

/**
 * Is this URL a loopback address?
 *
 * Parsed with `URL` rather than string-matched so `http://127.0.0.1@evil.tld/`
 * — which *contains* a loopback literal but resolves to `evil.tld` — is
 * correctly classified as off-host. An unparseable URL is treated as NOT
 * loopback, so a malformed override warns rather than passing silently.
 */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}
