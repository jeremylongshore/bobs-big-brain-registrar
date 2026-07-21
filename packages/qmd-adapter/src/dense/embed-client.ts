/**
 * HTTP client for the local embedding service (blueprint bead B4; decisions
 * 038-AT-DECR + 044-AT-DECR: sqlite-vec + EmbeddingGemma-300M only).
 *
 * Talks to the loopback-only `bbb-embedder` systemd user service — the same
 * SHA-256-pinned llama.cpp `llama-server` runtime the reranker uses (B1),
 * running the pinned EmbeddingGemma-300M GGUF with `--embedding` enabled.
 * No external API is ever in this path.
 *
 * FAIL-OPEN CONTRACT (read-path only): every failure mode — connection
 * refused, timeout, non-200, malformed JSON, dimension mismatch — returns
 * `null`. On the query path the caller serves the lexical fusion without a
 * dense list; on the index path the dense index simply stays stale. Dense is
 * an opt-in recall boost, never a dependency the serving path can die on.
 */

/**
 * A dense embedding-similarity score — a MODEL-DERIVED number, branded so it
 * can never be mistaken for (or assigned to) the govern side's
 * DeterministicScore. It lives above the spool: read-path candidate
 * generation only, never durable state.
 */
export type DenseScore = number & {
  readonly __brand: 'retrieval-dense-score';
};

/** Brand a raw model-derived similarity as a retrieval-side dense score. */
export function denseScore(value: number): DenseScore {
  return value as DenseScore;
}

/**
 * EmbeddingGemma prompt-prefix contract (the model card's retrieval prompts).
 * Queries and documents MUST be embedded with their respective prefixes or
 * similarity quality degrades — the model was trained asymmetric.
 */
export const EMBEDDINGGEMMA_QUERY_PREFIX = 'task: search result | query: ';
export const EMBEDDINGGEMMA_DOCUMENT_PREFIX = 'title: none | text: ';

/** Which side of the asymmetric retrieval pair a text is embedded as. */
export type EmbedRole = 'query' | 'document';

export interface EmbedClientOptions {
  /** Base URL of the embedding service, e.g. `http://127.0.0.1:8098`. */
  url: string;
  /**
   * Hard per-request timeout. Default 5000 ms — sized for a single query
   * embed; the indexer passes a much larger budget for document batches.
   */
  timeoutMs?: number;
}

export const DEFAULT_EMBED_TIMEOUT_MS = 5000;

/** Shape of llama-server's /v1/embeddings response (subset we consume). */
interface EmbeddingsApiResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
}

export class EmbedClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: EmbedClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  }

  /**
   * Embed `texts` via POST /v1/embeddings, applying the EmbeddingGemma
   * role prefix to each. Returns one vector per input, in input order.
   * Returns `null` on ANY failure — the caller MUST treat that as
   * "no dense signal available", never as an error to surface.
   */
  async embed(texts: readonly string[], role: EmbedRole): Promise<Float32Array[] | null> {
    if (texts.length === 0) return [];
    const prefix = role === 'query' ? EMBEDDINGGEMMA_QUERY_PREFIX : EMBEDDINGGEMMA_DOCUMENT_PREFIX;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'embedding', input: texts.map((t) => prefix + t) }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const parsed = (await response.json()) as EmbeddingsApiResponse;
      if (!Array.isArray(parsed.data) || parsed.data.length !== texts.length) return null;
      const vectors: Float32Array[] = new Array<Float32Array>(texts.length);
      let dims = -1;
      for (const entry of parsed.data) {
        if (
          typeof entry?.index !== 'number' ||
          entry.index < 0 ||
          entry.index >= texts.length ||
          !Array.isArray(entry.embedding) ||
          entry.embedding.length === 0 ||
          entry.embedding.some((v) => typeof v !== 'number' || !Number.isFinite(v))
        ) {
          return null; // malformed row — distrust the whole response
        }
        if (dims === -1) dims = entry.embedding.length;
        else if (entry.embedding.length !== dims) return null; // ragged dims
        vectors[entry.index] = Float32Array.from(entry.embedding);
      }
      // Every slot must be filled exactly once (duplicate indexes leave
      // holes). NOTE: an indexed for-loop, not `.some()` — Array#some skips
      // the empty slots of a sparse array, which is exactly what a hole is.
      for (let i = 0; i < vectors.length; i++) {
        if (vectors[i] === undefined) return null;
      }
      return vectors;
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
