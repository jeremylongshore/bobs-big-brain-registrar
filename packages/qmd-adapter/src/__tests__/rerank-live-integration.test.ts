import { connect } from 'node:net';

import { describe, expect, it } from 'vitest';

import { RerankClient } from '../rerank/rerank-client.js';

/**
 * Live integration against the real `bbb-reranker` systemd user service
 * (llama-server + pinned Qwen3-Reranker-0.6B on loopback :8097; see
 * scripts/bbb-reranker.service and the runbook 046-AT-RNBK).
 *
 * Skipped (not failed) when nothing is listening on the port, so CI and boxes
 * without the service stay green — the same posture as the other live tests.
 */
const RERANKER_PORT = 8097;
const RERANKER_URL = `http://127.0.0.1:${RERANKER_PORT}`;

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

const serviceUp = await portOpen(RERANKER_PORT);

describe.skipIf(!serviceUp)('live bbb-reranker service (B1)', () => {
  it('answers the health probe', async () => {
    const client = new RerankClient({ url: RERANKER_URL, timeoutMs: 5000 });
    expect(await client.healthy()).toBe(true);
  });

  // Generous timeouts: the live service is a single-slot CPU model — when a
  // large offline job (the KR1.3 eval arm) holds the slot, a 2-doc request
  // queues behind a multi-minute batch. Contention is expected, not failure.
  it(
    'scores an obviously-relevant document above an obviously-irrelevant one',
    { timeout: 300_000 },
    async () => {
      const client = new RerankClient({ url: RERANKER_URL, timeoutMs: 240_000 });
      const documents = [
        'Bananas are yellow and grow in bunches.',
        'The audit log is a hash-chained append-only JSONL file verified by ico audit verify.',
      ];
      const scored = await client.rerank('how is the audit log verified', documents);
      expect(scored).not.toBeNull();
      expect(scored).toHaveLength(2);
      const byIndex = new Map(scored?.map((s) => [s.index, s.score as number]));
      expect(byIndex.get(1)).toBeGreaterThan(byIndex.get(0) as number);
    },
  );
});
