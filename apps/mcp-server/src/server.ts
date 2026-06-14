import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MemoryCategory, MemoryLifecycleState, SearchScope } from '@qmd-team-intent-kb/schema';
import type { McpServerConfig } from './config.js';
import { propose } from './tools/propose.js';
import { searchTool } from './tools/search.js';
import { importFiles } from './tools/import.js';
import { getStatus } from './tools/status.js';
import { applyTransition } from './tools/transition.js';
import { runSync, isQmdAvailable } from './tools/sync.js';
import { vaultPreview, vaultExecute, vaultRollback } from './tools/vault-import.js';
import { createDatabase, MemoryLinksRepository } from '@qmd-team-intent-kb/store';

const VERSION = '0.1.0';

/**
 * Create a configured McpServer with all team-kb tools registered.
 *
 * Call `isQmdAvailable()` before calling this function if you want to
 * conditionally register the sync tool.
 */
export function createServer(
  config: McpServerConfig,
  options: { withSync?: boolean } = {},
): McpServer {
  const server = new McpServer({ name: 'teamkb', version: VERSION });

  // -------------------------------------------------------------------------
  // teamkb_propose — queue a memory candidate for governance review
  // -------------------------------------------------------------------------
  server.tool(
    'teamkb_propose',
    'Queue a new memory candidate for governance review. Writes to the spool only — the curator promotes it after policy checks pass.',
    {
      title: z.string().min(1).describe('Short descriptive title for the memory'),
      content: z.string().min(1).describe('Full content of the memory'),
      category: MemoryCategory.optional().describe(
        'Memory category: decision, pattern, convention, architecture, troubleshooting, onboarding, reference',
      ),
      filePaths: z
        .array(z.string())
        .optional()
        .describe('Source file paths this memory relates to'),
    },
    async (params) => {
      const result = await propose(
        {
          title: params.title,
          content: params.content,
          category: params.category,
          filePaths: params.filePaths,
        },
        config,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // teamkb_search — cited retrieval over the governed corpus
  // -------------------------------------------------------------------------
  server.tool(
    'teamkb_search',
    'Search the governed team knowledge base and return qmd:// citations. Every hit is anchored to a verifiable source — this is how the brain answers with receipts, not just recall. Read-only; defaults to the curated scope.',
    {
      query: z.string().min(1).describe('Natural-language search query'),
      scope: SearchScope.optional().describe(
        'Search scope: curated (default, governed memories), all, inbox, or archived',
      ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of cited hits to return (default 10)'),
    },
    async (params) => {
      const result = await searchTool(
        { query: params.query, scope: params.scope, limit: params.limit },
        config,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // teamkb_import — bulk import files matching a glob pattern
  // -------------------------------------------------------------------------
  server.tool(
    'teamkb_import',
    'Bulk import files matching a glob pattern as memory candidates. Each file becomes one candidate queued for governance review.',
    {
      glob: z.string().min(1).describe('Glob pattern relative to basePath (e.g. "docs/**/*.md")'),
      basePath: z
        .string()
        .optional()
        .describe('Base directory for glob resolution. Defaults to process.cwd()'),
    },
    async (params) => {
      const result = await importFiles({ glob: params.glob, basePath: params.basePath }, config);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // teamkb_status — read database counts and recent feedback
  // -------------------------------------------------------------------------
  server.tool(
    'teamkb_status',
    'Return memory counts by lifecycle state, category, and tenant, plus recent governance feedback entries.',
    {},
    async () => {
      const result = getStatus(config);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // teamkb_transition — user-initiated lifecycle transitions
  // -------------------------------------------------------------------------
  server.tool(
    'teamkb_transition',
    'Apply a lifecycle transition to a curated memory. Validates against the state machine and writes an audit event.',
    {
      memoryId: z.string().uuid().describe('UUID of the curated memory to transition'),
      to: MemoryLifecycleState.describe('Target lifecycle state'),
      reason: z.string().min(1).describe('Human-readable reason for the transition'),
      actor: z
        .string()
        .min(1)
        .describe('Identifier of the person or system initiating the transition'),
    },
    async (params) => {
      const result = applyTransition(
        {
          memoryId: params.memoryId,
          to: params.to,
          reason: params.reason,
          actor: params.actor,
        },
        config,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // teamkb_vault_preview — dry-run vault import analysis
  // -------------------------------------------------------------------------
  server.tool(
    'teamkb_vault_preview',
    'Preview a vault directory import without persisting. Reports file counts, collisions, and what would be created.',
    {
      sourcePath: z.string().min(1).describe('Absolute path to the vault/directory to import'),
      excludeDirs: z
        .array(z.string())
        .optional()
        .describe('Additional directory names to exclude (beyond .obsidian, .trash, .git)'),
    },
    async (params) => {
      const result = await vaultPreview(
        { sourcePath: params.sourcePath, excludeDirs: params.excludeDirs },
        config,
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // teamkb_vault_import — execute vault import with batch tracking
  // -------------------------------------------------------------------------
  server.tool(
    'teamkb_vault_import',
    'Import a vault directory as memory candidates with batch tracking. Parses Markdown frontmatter, detects collisions, creates candidates. Excludes .obsidian/.trash/.git by default.',
    {
      sourcePath: z.string().min(1).describe('Absolute path to the vault/directory to import'),
      excludeDirs: z
        .array(z.string())
        .optional()
        .describe('Additional directory names to exclude (beyond .obsidian, .trash, .git)'),
    },
    async (params) => {
      const result = await vaultExecute(
        { sourcePath: params.sourcePath, excludeDirs: params.excludeDirs },
        config,
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // teamkb_vault_rollback — roll back an import batch
  // -------------------------------------------------------------------------
  server.tool(
    'teamkb_vault_rollback',
    'Roll back a vault import batch. Deletes all candidates created by the batch, removes associated memory links, and marks the batch as rolled_back.',
    {
      batchId: z.string().min(1).describe('UUID of the import batch to roll back'),
    },
    async (params) => {
      const result = vaultRollback({ batchId: params.batchId }, config);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // teamkb_neighbors — get linked memories for a given memory
  // -------------------------------------------------------------------------
  server.tool(
    'teamkb_neighbors',
    'Return all memories linked to the given memory (both directions). Shows link types, weights, and direction (outgoing/incoming). Useful for exploring the knowledge graph from a specific node.',
    {
      memoryId: z.string().uuid().describe('UUID of the curated memory to find neighbors for'),
    },
    async (params) => {
      const db = createDatabase({ path: config.dbPath });
      try {
        const linksRepo = new MemoryLinksRepository(db);
        const neighbors = linksRepo.neighbors(params.memoryId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(neighbors, null, 2) }],
        };
      } finally {
        db.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // teamkb_sync — rebuild qmd vector index (registered only if qmd is present)
  // -------------------------------------------------------------------------
  if (options.withSync === true) {
    server.tool(
      'teamkb_sync',
      'Rebuild the local qmd vector index by running `qmd embed`. May take up to 2 minutes on large corpora.',
      {},
      async () => {
        const result = await runSync();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
  }

  return server;
}

// Re-export for convenience
export { isQmdAvailable };
