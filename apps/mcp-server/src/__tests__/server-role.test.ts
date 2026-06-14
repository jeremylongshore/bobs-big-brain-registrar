import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import type { McpServerConfig } from '../config.js';

const READ_TOOLS = ['teamkb_search', 'teamkb_status', 'teamkb_neighbors'];
const WRITE_TOOLS = [
  'teamkb_propose',
  'teamkb_import',
  'teamkb_transition',
  'teamkb_vault_preview',
  'teamkb_vault_import',
  'teamkb_vault_rollback',
];

function makeConfig(): McpServerConfig {
  const base = '/tmp/teamkb-role-test';
  return {
    tenantId: 'test-tenant',
    basePath: base,
    spoolPath: join(base, 'spool'),
    dbPath: join(base, 'teamkb.db'),
    feedbackPath: join(base, 'feedback'),
    exportDir: join(base, 'kb-export'),
  };
}

/** Connect a client over an in-memory transport and list the exposed tools. */
async function listToolNames(canWrite: boolean): Promise<string[]> {
  const server = createServer(makeConfig(), { canWrite });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP tool gating by role', () => {
  it('member install exposes read tools only (no write tools)', async () => {
    const names = await listToolNames(false);
    for (const t of READ_TOOLS) expect(names).toContain(t);
    for (const t of WRITE_TOOLS) expect(names).not.toContain(t);
  });

  it('admin install exposes read + write tools', async () => {
    const names = await listToolNames(true);
    for (const t of READ_TOOLS) expect(names).toContain(t);
    for (const t of WRITE_TOOLS) expect(names).toContain(t);
  });

  it('teamkb_search is always available (the brain query surface)', async () => {
    expect(await listToolNames(false)).toContain('teamkb_search');
    expect(await listToolNames(true)).toContain('teamkb_search');
  });
});
