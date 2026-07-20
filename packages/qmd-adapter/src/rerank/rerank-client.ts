/**
 * HTTP client for the local reranker service (blueprint bead B1; decision
 * 044-AT-DECR reranker-first).
 *
 * Talks to the loopback-only `bbb-reranker` systemd user service — a
 * SHA-256-pinned llama.cpp `llama-server` running the pinned
 * Qwen3-Reranker-0.6B GGUF with `/v1/rerank` enabled. No external API is ever
 * in this path.
 *
 * FAIL-OPEN CONTRACT (read-path only): every failure mode — connection
 * refused, timeout, non-200, malformed JSON — returns `null`, and the caller
 * (RerankStage) serves the deterministic fused order instead. Rerank is an
 * opt-in quality boost on the read path, never a dependency the serving path
 * can die on.
 */

/**
 * A cross-encoder relevance score — a MODEL-DERIVED number, branded so it can
 * never be mistaken for (or assigned to) the govern side's DeterministicScore.
 * It lives above the spool: read-path ordering only, never durable state.
 */
export type RerankScore = number & {
  readonly __brand: 'retrieval-rerank-score';
};

/** Brand a raw model output as a retrieval-side rerank score. */
export function rerankScore(value: number): RerankScore {
  return value as RerankScore;
}

/** One scored document from the rerank endpoint. */
export interface RerankScoredDoc {
  /** Index into the `documents` array that was sent. */
  index: number;
  score: RerankScore;
}

export interface RerankClientOptions {
  /** Base URL of the reranker service, e.g. `http://127.0.0.1:8097`. */
  url: string;
  /** Hard per-request timeout. Default 3000 ms. */
  timeoutMs?: number;
}

export const DEFAULT_RERANK_TIMEOUT_MS = 3000;

/** Shape of llama-server's /v1/rerank response (subset we consume). */
interface RerankApiResponse {
  results?: Array<{ index?: number; relevance_score?: number }>;
}

export class RerankClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: RerankClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS;
  }

  /**
   * Score `documents` against `query` via POST /v1/rerank.
   *
   * Returns one scored entry per input document (the endpoint scores all
   * documents; `top_n` is deliberately NOT sent so the caller can cache a
   * score for every candidate). Returns `null` on ANY failure — the caller
   * MUST treat that as "serve the fused order".
   */
  async rerank(query: string, documents: readonly string[]): Promise<RerankScoredDoc[] | null> {
    if (documents.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'reranker', query, documents }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const parsed = (await response.json()) as RerankApiResponse;
      if (!Array.isArray(parsed.results)) return null;
      const scored: RerankScoredDoc[] = [];
      for (const entry of parsed.results) {
        if (
          typeof entry?.index !== 'number' ||
          typeof entry.relevance_score !== 'number' ||
          Number.isNaN(entry.relevance_score) ||
          entry.index < 0 ||
          entry.index >= documents.length
        ) {
          return null; // malformed row — distrust the whole response
        }
        scored.push({ index: entry.index, score: rerankScore(entry.relevance_score) });
      }
      return scored;
    } catch {
      // Connection refused, abort/timeout, DNS, bad JSON body — all fail open.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Probe GET /health. `false` on any failure — never throws. */
  async healthy(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
