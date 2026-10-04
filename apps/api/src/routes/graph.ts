import type { FastifyInstance } from 'fastify';
import { ApiError, notFound, badRequest } from '../errors.js';
import type { MemoryLinksRepository, Neighbor, GraphNode } from '@qmd-team-intent-kb/store';
import type { MemoryRepository } from '@qmd-team-intent-kb/store';
import { isAudienceVisibleToRole } from '@qmd-team-intent-kb/common';
import type { ReaderRole } from '@qmd-team-intent-kb/common';
import { readerRoleOf } from '../middleware/api-key-auth.js';

/**
 * Claim-level audience gate for graph reads (K2). True when the memory exists
 * AND the caller may read it; a link to a memory the caller is not cleared for
 * is dropped, so the graph never names a memory the caller could not fetch.
 */
function isReadable(memoryRepo: MemoryRepository, id: string, role: ReaderRole): boolean {
  const memory = memoryRepo.findById(id);
  return memory !== null && isAudienceVisibleToRole(memory.metadata.audience, role);
}

const MAX_DEPTH = 5;
const DEFAULT_DEPTH = 2;

/**
 * Register graph traversal routes.
 *
 * GET /api/memories/:id/neighbors   — direct neighbors (both directions, depth 1)
 * GET /api/memories/:id/graph       — recursive CTE traversal (?depth=2, max 5)
 */
export function registerGraphRoutes(
  app: FastifyInstance,
  linksRepo: MemoryLinksRepository,
  memoryRepo: MemoryRepository,
): void {
  app.get(
    '/api/memories/:id/neighbors',
    {
      schema: {
        tags: ['graph'],
        summary: 'Get direct neighbors of a memory',
        description:
          'Returns all memories linked to or from the given memory, ' +
          'including link type, weight, and direction (outgoing/incoming).',
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };

        const role = readerRoleOf(request);
        if (!isReadable(memoryRepo, id, role)) {
          throw notFound(`Memory ${id} not found`);
        }

        const neighbors: Neighbor[] = linksRepo
          .neighbors(id)
          .filter((n) => isReadable(memoryRepo, n.memoryId, role));
        return reply.send(neighbors);
      } catch (err) {
        if (err instanceof ApiError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.get(
    '/api/memories/:id/graph',
    {
      schema: {
        tags: ['graph'],
        summary: 'Traverse the memory graph from a starting node',
        description:
          'Performs a recursive CTE traversal starting from the given memory. ' +
          'Returns all reachable nodes up to the requested depth (default 2, max 5), ' +
          'each annotated with its depth, link type, and weight.',
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = request.query as { depth?: string };

        let depth = DEFAULT_DEPTH;
        if (query.depth !== undefined) {
          const parsed = parseInt(query.depth, 10);
          if (isNaN(parsed) || parsed < 1) {
            throw badRequest(`depth must be a positive integer, got: ${query.depth}`);
          }
          depth = parsed;
        }

        if (depth > MAX_DEPTH) {
          throw badRequest(`depth exceeds maximum allowed value of ${MAX_DEPTH}`);
        }

        const role = readerRoleOf(request);
        if (!isReadable(memoryRepo, id, role)) {
          throw notFound(`Memory ${id} not found`);
        }

        const nodes: GraphNode[] = linksRepo
          .traverse(id, depth)
          .filter((n) => isReadable(memoryRepo, n.memoryId, role));
        return reply.send(nodes);
      } catch (err) {
        if (err instanceof ApiError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
