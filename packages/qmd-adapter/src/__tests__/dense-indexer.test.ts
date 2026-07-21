import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DenseVecIndex } from '../dense/dense-index.js';
import { DenseIndexer, type DenseIndexerOptions } from '../dense/dense-indexer.js';
import { EmbedClient } from '../dense/embed-client.js';

/**
 * Deterministic stub embedder: hashes each input string into a 4-dim unit
 * vector, counts how many documents it has embedded, and can be flipped
 * "down" (connection-refused semantics via server close is covered in the
 * embed-client tests; here `down` returns 503 so the same server object can
 * flip mid-test).
 */
class StubEmbedder {
  readonly server: Server;
  embeddedTexts: string[] = [];
  down = false;
  /** When set, the Nth (1-based) /v1/embeddings request and everything after it flips the stub down (durable outage). */
  failFromEmbedRequest: number | null = null;
  /** When >0, the next N /v1/embeddings requests 503 and then recover (transient outage) — decremented per embed request. */
  failNextEmbedRequests = 0;
  private embedRequests = 0;
  private baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => {
      const isEmbed = req.url !== '/health';
      if (isEmbed) {
        this.embedRequests++;
        if (this.failFromEmbedRequest !== null && this.embedRequests >= this.failFromEmbedRequest) {
          this.down = true;
        }
      }
      // Transient outage: fail this embed request but recover afterwards.
      if (isEmbed && this.failNextEmbedRequests > 0) {
        this.failNextEmbedRequests--;
        res.writeHead(503);
        res.end();
        return;
      }
      if (this.down) {
        res.writeHead(503);
        res.end();
        return;
      }
      if (req.url === '/health') {
        res.writeHead(200);
        res.end('{"status":"ok"}');
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const { input } = JSON.parse(body) as { input: string[] };
        // Data-poison: any input containing POISON_MARKER is OMITTED from the
        // response (models llama-server's per-input "too large" send_error),
        // so the batch comes back with fewer rows than requested — a partial
        // the client distrusts as null — while /health stays 200 (service up).
        const kept = input
          .map((text, index) => ({ text, index }))
          .filter((e) => !e.text.includes(StubEmbedder.POISON_MARKER));
        this.embeddedTexts.push(...kept.map((e) => e.text));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: kept.map((e) => ({ index: e.index, embedding: StubEmbedder.vectorFor(e.text) })),
          }),
        );
      });
    });
  }

  /** Inputs containing this marker are rejected (omitted) by the stub — models a per-input server error. */
  static readonly POISON_MARKER = 'POISON_DOC';

  /** Hash a string into a stable 4-dim unit vector. */
  static vectorFor(text: string): number[] {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    }
    const raw = [1 + (h & 0xff), 1 + ((h >> 8) & 0xff), 1 + ((h >> 16) & 0xff), 1];
    const norm = Math.hypot(...raw);
    return raw.map((c) => c / norm);
  }

  listen(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address() as AddressInfo;
        this.baseUrl = `http://127.0.0.1:${port}`;
        resolve(this.baseUrl);
      });
    });
  }

  close(): void {
    this.server.close();
  }
}

describe('DenseIndexer (B4) — incremental embed sweep over the export tree', () => {
  let stub: StubEmbedder;
  let url: string;
  let exportDir: string;
  let index: DenseVecIndex;

  beforeEach(async () => {
    stub = new StubEmbedder();
    url = await stub.listen();
    exportDir = mkdtempSync(join(tmpdir(), 'dense-indexer-test-'));
    mkdirSync(join(exportDir, 'curated'), { recursive: true });
    mkdirSync(join(exportDir, 'guides'), { recursive: true });
    writeFileSync(join(exportDir, 'curated', 'a.md'), '# Doc A about audits');
    writeFileSync(join(exportDir, 'curated', 'b.md'), '# Doc B about backups');
    writeFileSync(join(exportDir, 'guides', 'g.md'), '# Guide G about deploys');
    index = new DenseVecIndex({ path: ':memory:', modelId: 'm', modelVersion: 'v' });
  });

  afterEach(() => {
    stub.close();
    index.close();
    rmSync(exportDir, { recursive: true, force: true });
  });

  function makeIndexer(batchSize = 2, retry?: Partial<DenseIndexerOptions>): DenseIndexer {
    return new DenseIndexer({
      index,
      client: new EmbedClient({ url, timeoutMs: 5000 }),
      exportDir,
      batchSize,
      // Tiny backoffs keep the retry tests fast; production defaults are seconds.
      maxBatchRetries: 3,
      retryBackoffMs: 5,
      maxRetryBackoffMs: 10,
      ...retry,
    });
  }

  it('first sync embeds every exportable doc with qmd:// citation ids', async () => {
    const report = await makeIndexer().sync();
    expect(report).toMatchObject({ embedded: 3, removed: 0, skipped: 0, serviceDown: false });
    expect(report.totalDocs).toBe(3);
    expect(index.count()).toBe(3);
    expect(
      index
        .entries()
        .map((e) => e.docId)
        .sort(),
    ).toEqual(['qmd://kb-curated/a.md', 'qmd://kb-curated/b.md', 'qmd://kb-guides/g.md']);
  });

  it('re-sync is incremental: unchanged docs are never re-sent to the model', async () => {
    await makeIndexer().sync();
    stub.embeddedTexts = [];
    const report = await makeIndexer().sync();
    expect(report).toMatchObject({ embedded: 0, removed: 0, skipped: 0, serviceDown: false });
    expect(stub.embeddedTexts).toEqual([]); // zero model calls
  });

  it('a changed doc is re-embedded (content-hash keyed, not mtime)', async () => {
    await makeIndexer().sync();
    stub.embeddedTexts = [];
    writeFileSync(join(exportDir, 'curated', 'a.md'), '# Doc A REWRITTEN');
    const report = await makeIndexer().sync();
    expect(report.embedded).toBe(1);
    expect(stub.embeddedTexts).toHaveLength(1);
    expect(stub.embeddedTexts[0]).toContain('REWRITTEN');
    expect(index.count()).toBe(3); // replaced, not duplicated
  });

  it('a deleted doc is removed from the index', async () => {
    await makeIndexer().sync();
    unlinkSync(join(exportDir, 'curated', 'b.md'));
    const report = await makeIndexer().sync();
    expect(report).toMatchObject({ embedded: 0, removed: 1 });
    expect(index.count()).toBe(2);
    expect(index.entries().some((e) => e.docId === 'qmd://kb-curated/b.md')).toBe(false);
  });

  it('service down: sweep degrades to a stale index, never throws', async () => {
    stub.down = true;
    const report = await makeIndexer().sync();
    expect(report).toMatchObject({ embedded: 0, skipped: 3, serviceDown: true });
    expect(index.count()).toBe(0); // stale (empty) — and search on it just returns []
  });

  it('service DURABLY down mid-sweep: batch retried to exhaustion, remainder aborted, prior work kept', async () => {
    // Batch size 1 → three embed requests. The 2nd request (and everything
    // after) flips the stub permanently down. Batch 1 lands; batch 2 fails
    // every retry (service never comes back) → abort with the remainder skipped.
    stub.failFromEmbedRequest = 2;
    const report = await makeIndexer(1).sync();
    expect(report.serviceDown).toBe(true);
    expect(report.embedded).toBe(1); // first batch landed and is kept
    expect(report.skipped).toBe(2); // the exhausted batch + the aborted remainder
    expect(index.count()).toBe(1);
  });

  it('TRANSIENT outage mid-sweep: retry bridges an auto-restart and the build completes', async () => {
    // Model a ~restart blip: the first 2 embed requests 503, then the service
    // recovers. Batch size 1 → batch 1's doc fails twice and succeeds on its
    // 3rd attempt (inside the retry budget); batches 2-3 then sail through. The
    // whole build completes despite the outage — no work discarded.
    stub.failNextEmbedRequests = 2;
    const report = await makeIndexer(1).sync();
    expect(report.serviceDown).toBe(false);
    expect(report.embedded).toBe(3); // all three docs embedded despite the blip
    expect(report.skipped).toBe(0);
    expect(index.count()).toBe(3);
  });

  it('DATA-POISON batch: skipped (service healthy), build continues with the good docs', async () => {
    // A doc the server will never accept (models an input that exceeds the
    // physical batch size). Batch size 1 isolates it: its batch fails every
    // retry, the health probe says UP → skip that one doc and keep going.
    writeFileSync(
      join(exportDir, 'curated', 'poison.md'),
      `# ${StubEmbedder.POISON_MARKER} oversized`,
    );
    const report = await makeIndexer(1).sync();
    expect(report.serviceDown).toBe(false); // NOT a false outage
    expect(report.embedded).toBe(3); // the 3 good docs still embedded
    expect(report.skipped).toBe(1); // only the poison doc skipped
    expect(index.count()).toBe(3);
    expect(index.entries().some((e) => e.docId.includes('poison'))).toBe(false);
  });

  it('batch exhausts the retry budget but /health is up → skip that batch, keep building (not a false outage)', async () => {
    // maxBatchRetries: 1 → 2 attempts per batch. Fail the first 2 embed
    // requests (batch 1 exhausts its budget) but health stays 200 throughout.
    // batchSize 2 → batch1=[a,b] can't recover in budget and is SKIPPED
    // (health up = not an outage); batch2=[g] then succeeds. The build finishes
    // rather than aborting the whole thing on a transient that outlasts budget.
    stub.failNextEmbedRequests = 2;
    const report = await makeIndexer(2, { maxBatchRetries: 1 }).sync();
    expect(report.serviceDown).toBe(false);
    expect(report.embedded).toBe(1); // batch2's doc
    expect(report.skipped).toBe(2); // batch1's two docs skipped, not the whole build
  });

  it('after an outage, the next sync picks up exactly the missing docs', async () => {
    stub.down = true;
    await makeIndexer().sync();
    stub.down = false;
    const report = await makeIndexer().sync();
    expect(report).toMatchObject({ embedded: 3, skipped: 0, serviceDown: false });
    expect(index.count()).toBe(3);
  });
});
