import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { propose } from '../tools/propose.js';
import { importFiles } from '../tools/import.js';

describe('Registrar MCP refuses unsupported source evidence', () => {
  it('rejects reserved evidence on real propose/import SDK calls and direct helpers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-source-evidence-'));
    const config = {
      tenantId: 'synthetic',
      basePath: root,
      spoolPath: root,
      dbPath: join(root, 'store.db'),
      feedbackPath: join(root, 'feedback'),
      role: 'admin' as const,
    };
    const server = createServer(config);
    const client = new Client({ name: 'synthetic-source-client', version: '1' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(s), client.connect(c)]);
      expect((await client.listTools()).tools.some((t) => t.name === 'teamkb_propose')).toBe(true);
      for (const field of [
        'sourceEvidence',
        'sourceAssertion',
        'sourceClassification',
        'assertion',
      ]) {
        for (const name of ['teamkb_propose', 'teamkb_import']) {
          const result = await client.callTool({
            name,
            arguments: {
              title: 'Synthetic title',
              content: 'Synthetic content',
              glob: '*.md',
              [field]: 'synthetic-evidence',
            },
          });
          expect(result.isError).toBe(true);
        }
        await expect(
          propose(
            { title: 'Synthetic title', content: 'Synthetic content', [field]: 'evidence' },
            config,
          ),
        ).rejects.toThrow('source_evidence_unsupported');
        await expect(importFiles({ glob: '*.md', [field]: 'evidence' }, config)).rejects.toThrow(
          'source_evidence_unsupported',
        );
      }
      expect(await readdir(root)).toEqual([]);
      const ordinary = await client.callTool({
        name: 'teamkb_propose',
        arguments: {
          title: 'Synthetic proposal',
          content: 'Ordinary proposal remains review-bound.',
        },
      });
      expect(ordinary.isError).not.toBe(true);
      expect((await readdir(root)).some((name) => name.endsWith('.jsonl'))).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
