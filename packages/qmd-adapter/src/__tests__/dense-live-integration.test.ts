import { connect } from 'node:net';

import { describe, expect, it } from 'vitest';

import { DenseVecIndex } from '../dense/dense-index.js';
import { EmbedClient } from '../dense/embed-client.js';

/**
 * Live integration against the real `bbb-embedder` systemd user service
 * (llama-server + pinned EmbeddingGemma-300M on loopback :8098; see
 * scripts/bbb-embedder.service and the runbook 051-AT-RNBK).
 *
 * Skipped (not failed) when nothing is listening on the port, so CI and boxes
 * without the service stay green — the same posture as the other live tests.
 */
const EMBEDDER_PORT = 8098;
const EMBEDDER_URL = `http://127.0.0.1:${EMBEDDER_PORT}`;

function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const serviceUp = await portOpen(EMBEDDER_PORT);

describe.skipIf(!serviceUp)('live bbb-embedder service (B4)', () => {
  it('answers the health probe', async () => {
    const client = new EmbedClient({ url: EMBEDDER_URL, timeoutMs: 5000 });
    expect(await client.healthy()).toBe(true);
  });

  it(
    'ranks an obviously-relevant document above an obviously-irrelevant one end-to-end (embed → sqlite-vec KNN)',
    { timeout: 60_000 },
    async () => {
      const client = new EmbedClient({ url: EMBEDDER_URL, timeoutMs: 30_000 });
      const docs = [
        {
          docId: 'qmd://kb-curated/audit.md',
          text: 'The audit log is a hash-chained append-only JSONL file verified by ico audit verify.',
        },
        {
          docId: 'qmd://kb-curated/bananas.md',
          text: 'Bananas are yellow and grow in bunches.',
        },
      ];
      const docVectors = await client.embed(
        docs.map((d) => d.text),
        'document',
      );
      expect(docVectors).not.toBeNull();
      expect(docVectors).toHaveLength(2);

      const index = new DenseVecIndex({ path: ':memory:', modelId: 'live', modelVersion: 'live' });
      docs.forEach((doc, i) => {
        const embedding = docVectors?.[i];
        if (embedding === undefined) throw new Error('missing vector');
        index.upsert({
          docId: doc.docId,
          collection: 'kb-curated',
          contentHash: `h${i}`,
          snippet: doc.text.slice(0, 40),
          embedding,
        });
      });

      const queryVectors = await client.embed(['how is the audit log verified'], 'query');
      const queryVec = queryVectors?.[0];
      expect(queryVec).toBeDefined();
      if (queryVec === undefined) return;

      const hits = index.search(queryVec, 2);
      expect(hits.map((h) => h.id)).toEqual([
        'qmd://kb-curated/audit.md',
        'qmd://kb-curated/bananas.md',
      ]);
      expect(hits[0]?.score as number).toBeGreaterThan(hits[1]?.score as number);
      index.close();
    },
  );
});
