import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  /** Healthy single-slot service: requests above its document capacity fail. */
  maxDocumentsPerRequest = Number.POSITIVE_INFINITY;
  rejectedRequestCount = 0;
  readonly rejectedRequests: Array<{ method: string; path: string; reason: string }> = [];
  private embedRequests = 0;
  private readonly socketRoot = mkdtempSync(join(tmpdir(), 'dense-http-'));
  private readonly socketPath = join(this.socketRoot, 'fixture.sock');
  private readonly baseUrl = 'http://dense-fixture.invalid';

  get embeddingRequestCount(): number {
    return this.embedRequests;
  }

  constructor() {
    this.server = createServer((req, res) => {
      req.on('error', () => {
        this.recordRejection(req, 'request-error');
        res.destroy();
      });
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(this.down ? 503 : 200);
        res.end(this.down ? '' : '{"status":"ok"}');
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
        this.recordRejection(req, 'route');
        req.resume();
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          this.recordRejection(req, 'invalid-json');
          res.writeHead(400).end();
          return;
        }
        const input =
          parsed !== null && typeof parsed === 'object' && 'input' in parsed
            ? parsed.input
            : undefined;
        if (
          !Array.isArray(input) ||
          !input.every((text: unknown): text is string => typeof text === 'string')
        ) {
          this.recordRejection(req, 'invalid-input');
          res.writeHead(400).end();
          return;
        }
        this.embedRequests++;
        if (this.failFromEmbedRequest !== null && this.embedRequests >= this.failFromEmbedRequest) {
          this.down = true;
        }
        // Only valid embedding requests advance the transient outage counter.
        if (this.failNextEmbedRequests > 0) {
          this.failNextEmbedRequests--;
          res.writeHead(503).end();
          return;
        }
        if (this.down) {
          res.writeHead(503).end();
          return;
        }
        if (input.length > this.maxDocumentsPerRequest) {
          res.writeHead(503);
          res.end();
          return;
        }
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

  private recordRejection(req: IncomingMessage, reason: string): void {
    this.rejectedRequestCount++;
    if (this.rejectedRequests.length < 16) {
      this.rejectedRequests.push({
        method: (req.method ?? '').slice(0, 16),
        path: (req.url ?? '').split('?')[0]!.slice(0, 128),
        reason,
      });
    }
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

  /** Use a real HTTP Unix socket in an owned directory instead of a host TCP
   * port. Host loopback discovery cannot issue requests into this fixture.
   * The test adapter only transports this file's string-body requests; separate
   * embed-client tests retain the production fetch/TCP transport contract.
   */
  listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        vi.stubGlobal('fetch', this.fetch.bind(this));
        resolve(this.baseUrl);
      });
    });
  }

  private async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    if (input instanceof Request) throw new Error('Fixture Request objects are unsupported');
    const target = new URL(input);
    if (target.origin !== this.baseUrl) throw new Error('Fixture transport refuses another origin');
    if (init.body !== undefined && typeof init.body !== 'string') {
      throw new Error('Fixture transport requires a string body');
    }
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: target.pathname + target.search,
          method: init.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal ?? undefined,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 500,
                headers: Object.fromEntries(
                  Object.entries(res.headers).flatMap(([key, value]) =>
                    value === undefined
                      ? []
                      : [[key, Array.isArray(value) ? value.join(', ') : value]],
                  ),
                ),
              }),
            ),
          );
        },
      );
      req.on('error', reject);
      req.end(init.body);
    });
  }

  async close(): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => (error ? reject(error) : resolve()));
        this.server.closeAllConnections();
      });
    } finally {
      vi.unstubAllGlobals();
      rmSync(this.socketRoot, { recursive: true, force: true });
    }
  }
}

describe('DenseIndexer (B4) — incremental embed sweep over the export tree', () => {
  let stub: StubEmbedder;
  let url: string;
  let exportDir: string;
  let index: DenseVecIndex;
  let expectedRejections: number;

  beforeEach(async () => {
    expectedRejections = 0;
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

  afterEach(async () => {
    try {
      await stub.close();
    } finally {
      index.close();
      rmSync(exportDir, { recursive: true, force: true });
    }
    expect(stub.rejectedRequestCount, JSON.stringify(stub.rejectedRequests)).toBe(
      expectedRejections,
    );
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

  it('rejects malformed embedding requests without consuming valid-request outage controls', async () => {
    expectedRejections = 7;
    for (const body of [
      '',
      '{',
      JSON.stringify({ input: [null] }),
      JSON.stringify({ input: 'wrong' }),
    ]) {
      const response = await fetch(`${url}/v1/embeddings`, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(1_000),
      });
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
    expect(stub.embeddingRequestCount).toBe(0);
    stub.failNextEmbedRequests = 1;
    const invalid = await fetch(`${url}/v1/embeddings`, {
      method: 'POST',
      body: '',
      signal: AbortSignal.timeout(1_000),
    });
    expect(invalid.status).toBe(400);
    await invalid.arrayBuffer();
    const unknown = await fetch(`${url}/not-an-embedding-route`, {
      method: 'POST',
      body: JSON.stringify({ input: ['synthetic'] }),
      signal: AbortSignal.timeout(1_000),
    });
    expect(unknown.status).toBe(404);
    await unknown.arrayBuffer();
    const wrongMethod = await fetch(`${url}/v1/embeddings`, {
      signal: AbortSignal.timeout(1_000),
    });
    expect(wrongMethod.status).toBe(404);
    await wrongMethod.arrayBuffer();
    const client = new EmbedClient({ url });
    expect(await client.healthy()).toBe(true);
    expect(stub.embeddingRequestCount).toBe(0);
    expect(stub.failNextEmbedRequests).toBe(1);
    expect(await client.embed(['synthetic'], 'document')).toBeNull();
    expect(stub.embeddingRequestCount).toBe(1);
    expect(await client.embed(['synthetic'], 'document')).toHaveLength(1);
    expect(stub.embeddingRequestCount).toBe(2);
    expect(stub.rejectedRequestCount).toBe(7);
    expect(stub.rejectedRequests).toEqual([
      { method: 'POST', path: '/v1/embeddings', reason: 'invalid-json' },
      { method: 'POST', path: '/v1/embeddings', reason: 'invalid-json' },
      { method: 'POST', path: '/v1/embeddings', reason: 'invalid-input' },
      { method: 'POST', path: '/v1/embeddings', reason: 'invalid-input' },
      { method: 'POST', path: '/v1/embeddings', reason: 'invalid-json' },
      { method: 'POST', path: '/not-an-embedding-route', reason: 'route' },
      { method: 'GET', path: '/v1/embeddings', reason: 'route' },
    ]);
  });

  it('retains strict rejection accounting for an explicitly issued root request', async () => {
    expectedRejections = 1;
    expect(typeof stub.server.address()).toBe('string');
    const reply = await fetch(`${url}/`);
    expect(reply.status).toBe(404);
    await reply.arrayBuffer();
    expect(stub.rejectedRequests).toEqual([{ method: 'GET', path: '/', reason: 'route' }]);
    expect(stub.embeddingRequestCount).toBe(0);
  });

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

  it('indexes through a one-document-capacity stub without re-embedding unchanged documents', async () => {
    stub.maxDocumentsPerRequest = 1;
    const indexer = new DenseIndexer({
      index,
      client: new EmbedClient({ url, timeoutMs: 5000 }),
      exportDir,
      maxBatchRetries: 0,
    });
    const report = await indexer.sync();
    expect(report).toMatchObject({ embedded: 3, skipped: 0, serviceDown: false });
    expect(index.count()).toBe(3);
    expect(stub.embeddedTexts).toHaveLength(3);
    expect(stub.embeddingRequestCount).toBe(3);
    // The next sweep still scans files, but sends no embedding requests.
    stub.embeddedTexts = [];
    expect(await indexer.sync()).toMatchObject({ embedded: 0, skipped: 0 });
    expect(stub.embeddedTexts).toEqual([]);
    expect(stub.embeddingRequestCount).toBe(3);
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
