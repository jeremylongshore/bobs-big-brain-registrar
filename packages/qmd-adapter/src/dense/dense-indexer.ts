import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { computeContentHash } from '@qmd-team-intent-kb/common';

import { getExportableCollections } from '../collections/collection-registry.js';
import type { DenseVecIndex } from './dense-index.js';
import { DENSE_SNIPPET_CHARS } from './dense-index.js';
import type { EmbedClient } from './embed-client.js';

/**
 * Incremental embed sweep over the git-exporter output tree (bead B4).
 *
 * Same sweep shape as the native FTS5 `NativeIndexManager.ensureFresh()` —
 * every exportable collection's `<exportDir>/<sourceSubdir>/*.md`, doc ids
 * being the `qmd://` citations — but keyed on CONTENT HASH rather than mtime:
 * an embedding costs ~0.4 s of CPU model time per doc, so the diff key must
 * be the exact text that was embedded, not a filesystem timestamp a `touch`
 * or re-export can churn.
 *
 * DEGRADE CONTRACT: when the embedding service is down the sweep is a no-op
 * (`serviceDown: true`) and the index simply stays stale — dense retrieval
 * keeps serving yesterday's vectors, and the lexical arms are unaffected.
 *
 * RESILIENCE (B4, learned the hard way over several failed full builds):
 *   1. A batch failure is RETRIED with bounded exponential backoff (~45 s
 *      window). The embedder is a single-process CPU model under a
 *      `Restart=on-failure` unit; the retry bridges a transient crash +
 *      auto-restart instead of discarding the build on one blip.
 *   2. When retries are exhausted, a HEALTH PROBE decides: service down → a
 *      durable outage → abort the remainder as a stale index (fail-open);
 *      service up → the batch is DATA-POISON (an input the server rejects, e.g.
 *      longer than the physical batch size) → skip just those docs and keep
 *      building. One bad doc must never strand a 17k-doc index — the exact
 *      failure mode that aborted a full build after 32 docs when a real doc
 *      tokenized past the ubatch size.
 * Nothing here ever throws to the caller.
 */

/** Outcome of one dense index sync sweep. */
export interface DenseIndexReport {
  /** Docs (re-)embedded this sweep. */
  embedded: number;
  /** Docs removed because their export file is gone. */
  removed: number;
  /** Docs that needed embedding but were skipped by a mid-sweep failure. */
  skipped: number;
  /** Total exportable docs currently on disk. */
  totalDocs: number;
  /** True when the service was unreachable and the sweep did not run. */
  serviceDown: boolean;
}

/**
 * Chars of each doc embedded (the rest is truncated). 2000 chars ≈ ~500
 * EmbeddingGemma tokens — comfortably inside both the 2048-token model context
 * and a 1024-token `--parallel 2` slot. Chosen from the measured corpus +
 * throughput curve (2026-07-20, 17,310-doc frozen corpus): median doc is 2778
 * bytes and 93% exceed 1200 chars, so 1200 would truncate away most of the
 * body; embedding at 2000 vs 1200 chars costs only +23% wall-clock (~138 vs
 * ~112 min full-corpus) while capturing ~72% of the median doc vs ~43%. 3000
 * chars doubled the cost (~235 min) for diminishing corpus coverage, so 2000
 * is the recall/cost knee. Raising this re-embeds every doc on the next sweep
 * (the content hash changes) — deliberate.
 */
export const DEFAULT_DENSE_MAX_DOC_CHARS = 2000;
export const DEFAULT_DENSE_BATCH_SIZE = 16;

export interface DenseIndexerOptions {
  index: DenseVecIndex;
  client: EmbedClient;
  /** Root of the git-exporter output tree (same dir the lexical indexes read). */
  exportDir: string;
  /**
   * Truncate each document to this many chars before embedding (default
   * {@link DEFAULT_DENSE_MAX_DOC_CHARS} = 2000). EmbeddingGemma's context is
   * 2048 tokens; a governed memory's lead carries its summary+provenance
   * header (the semantic core) and 2000 chars covers the bulk of the median
   * doc. NOTE: changing this changes the embedded text, hence the content
   * hashes, hence triggers a full re-embed on the next sweep — deliberate.
   */
  maxDocChars?: number;
  /** Docs per /v1/embeddings request (default 16). */
  batchSize?: number;
  /**
   * How many times to RE-ATTEMPT a failed batch before concluding the service
   * is durably down (default 5, i.e. 6 total attempts). Bridges the embedder's
   * `Restart=on-failure` auto-recovery so a transient crash mid-build does not
   * discard the whole embed.
   */
  maxBatchRetries?: number;
  /** First retry backoff in ms (default 2000); doubles each attempt up to {@link DenseIndexerOptions.maxRetryBackoffMs}. */
  retryBackoffMs?: number;
  /** Cap on a single retry backoff in ms (default 15000). */
  maxRetryBackoffMs?: number;
}

/** Non-blocking sleep. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DenseIndexer {
  private readonly index: DenseVecIndex;
  private readonly client: EmbedClient;
  private readonly exportDir: string;
  private readonly maxDocChars: number;
  private readonly batchSize: number;
  private readonly maxBatchRetries: number;
  private readonly retryBackoffMs: number;
  private readonly maxRetryBackoffMs: number;

  constructor(options: DenseIndexerOptions) {
    this.index = options.index;
    this.client = options.client;
    this.exportDir = options.exportDir;
    this.maxDocChars = options.maxDocChars ?? DEFAULT_DENSE_MAX_DOC_CHARS;
    this.batchSize = options.batchSize ?? DEFAULT_DENSE_BATCH_SIZE;
    this.maxBatchRetries = options.maxBatchRetries ?? 5;
    this.retryBackoffMs = options.retryBackoffMs ?? 2000;
    this.maxRetryBackoffMs = options.maxRetryBackoffMs ?? 15_000;
  }

  /**
   * Embed one batch, RE-ATTEMPTING on failure with bounded exponential backoff.
   * Returns the vectors on success, or `null` only after the whole retry budget
   * is spent with the service still failing (a durable outage). A `null` from
   * `client.embed` is fail-fast (connection-refused during an auto-restart is
   * near-instant), so the wall-clock cost of a retry round is dominated by the
   * backoff, not by timeouts.
   */
  private async embedBatchWithRetry(texts: readonly string[]): Promise<Float32Array[] | null> {
    let backoff = this.retryBackoffMs;
    for (let attempt = 0; attempt <= this.maxBatchRetries; attempt++) {
      const vectors = await this.client.embed(texts, 'document');
      if (vectors !== null) return vectors;
      if (attempt === this.maxBatchRetries) break;
      await delay(backoff);
      backoff = Math.min(backoff * 2, this.maxRetryBackoffMs);
    }
    return null;
  }

  /**
   * Bring the dense index up to date with the export tree: embed new/changed
   * docs (batched), remove vanished ones, leave unchanged ones untouched.
   */
  async sync(): Promise<DenseIndexReport> {
    // On-disk truth: every exportable doc, with the exact text we would embed.
    const onDisk = new Map<
      string,
      { collection: string; text: string; contentHash: string; snippet: string }
    >();
    for (const def of getExportableCollections()) {
      const dir = join(this.exportDir, def.sourceSubdir);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        let raw: string;
        try {
          raw = readFileSync(join(dir, name), 'utf8');
        } catch {
          continue; // deleted between readdir and read
        }
        const text = raw.slice(0, this.maxDocChars);
        onDisk.set(`qmd://${def.name}/${name}`, {
          collection: def.name,
          text,
          contentHash: computeContentHash(text),
          snippet: raw.slice(0, DENSE_SNIPPET_CHARS),
        });
      }
    }

    const stored = new Map(this.index.entries().map((e) => [e.docId, e.contentHash]));

    const toEmbed: string[] = [];
    for (const [docId, info] of onDisk) {
      if (stored.get(docId) !== info.contentHash) toEmbed.push(docId);
    }
    const toRemove = [...stored.keys()].filter((docId) => !onDisk.has(docId));

    if (toRemove.length > 0) this.index.remove(toRemove);

    if (toEmbed.length > 0 && !(await this.client.healthy())) {
      // Service down and work pending: the index stays stale by design.
      return {
        embedded: 0,
        removed: toRemove.length,
        skipped: toEmbed.length,
        totalDocs: onDisk.size,
        serviceDown: true,
      };
    }

    let embedded = 0;
    let skipped = 0;
    for (let start = 0; start < toEmbed.length; start += this.batchSize) {
      const batchIds = toEmbed.slice(start, start + this.batchSize);
      const batchDocs = batchIds.map((id) => onDisk.get(id));
      const vectors = await this.embedBatchWithRetry(batchDocs.map((d) => d?.text ?? ''));
      if (vectors === null) {
        // The batch failed every retry across the whole backoff window. Two
        // very different causes, distinguished by a health probe:
        //   - service DOWN → a durable outage → abort the remainder as a stale
        //     index (fail-open); the next sweep resumes at the un-embedded docs.
        //   - service UP → the batch is DATA-POISON, not an outage: the server
        //     rejects an input it will never accept (e.g. an input longer than
        //     the physical batch size). Retrying it forever would strand the
        //     whole build on one bad doc — the exact failure that aborted a full
        //     17k build after 32 docs. So skip just these docs and keep going.
        if (await this.client.healthy()) {
          skipped += batchIds.length;
          continue;
        }
        skipped += toEmbed.length - start;
        return {
          embedded,
          removed: toRemove.length,
          skipped,
          totalDocs: onDisk.size,
          serviceDown: true,
        };
      }
      for (let i = 0; i < batchIds.length; i++) {
        const docId = batchIds[i];
        const info = docId === undefined ? undefined : onDisk.get(docId);
        const embedding = vectors[i];
        if (docId === undefined || info === undefined || embedding === undefined) continue;
        this.index.upsert({
          docId,
          collection: info.collection,
          contentHash: info.contentHash,
          snippet: info.snippet,
          embedding,
        });
        embedded++;
      }
    }

    return {
      embedded,
      removed: toRemove.length,
      skipped,
      totalDocs: onDisk.size,
      serviceDown: false,
    };
  }
}
