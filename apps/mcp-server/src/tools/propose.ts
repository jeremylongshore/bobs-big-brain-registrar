import { randomUUID } from 'node:crypto';
import type { MemoryCandidate, MemoryCategory } from '@qmd-team-intent-kb/schema';
import { MEMORY_CANDIDATE_SCHEMA_VERSION } from '@qmd-team-intent-kb/schema';
import { writeToSpool } from '@qmd-team-intent-kb/claude-runtime';
import type { McpServerConfig } from '../config.js';

/** Input for teamkb_propose */
interface ProposeInput {
  title: string;
  content: string;
  category?: MemoryCategory;
  filePaths?: string[];
}

/** Result shape returned to the MCP caller */
interface ProposeResult {
  candidateId: string;
  message: string;
}

/**
 * Propose a new memory candidate and write it to the spool.
 *
 * Does NOT touch SQLite. The curator reads from the spool on its next cycle
 * and applies governance policy before promotion.
 */
export async function propose(
  input: ProposeInput,
  config: McpServerConfig,
  nowFn: () => string = () => new Date().toISOString(),
): Promise<ProposeResult> {
  const candidateId = randomUUID();

  const candidate: MemoryCandidate = {
    schemaVersion: MEMORY_CANDIDATE_SCHEMA_VERSION,
    id: candidateId,
    status: 'inbox',
    source: 'mcp',
    content: input.content,
    title: input.title,
    category: input.category ?? 'reference',
    trustLevel: 'medium',
    author: { type: 'ai', id: 'mcp-server' },
    tenantId: config.tenantId,
    metadata: {
      filePaths: input.filePaths ?? [],
      tags: [],
    },
    prePolicyFlags: {
      potentialSecret: false,
      lowConfidence: false,
      duplicateSuspect: false,
    },
    capturedAt: nowFn(),
  };

  const result = await writeToSpool(candidate, config.spoolPath);

  if (!result.ok) {
    throw new Error(`Failed to write candidate to spool: ${result.error}`);
  }

  return {
    candidateId,
    message: `Candidate ${candidateId} queued for governance review`,
  };
}
