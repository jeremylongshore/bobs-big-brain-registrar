import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, notFound, badRequest } from '../errors.js';
import type {
  MemoryLinksRepository,
  Neighbor,
  GraphNode,
  GraphReadScope,
} from '@qmd-team-intent-kb/store';
import type { MemoryRepository } from '@qmd-team-intent-kb/store';
import { isAudienceVisibleToRole } from '@qmd-team-intent-kb/common';
import { readerRoleOf } from '../middleware/api-key-auth.js';

/** Effective selection is injected/validated by the tenancy guard. Keep the
 * token allowlist as a second constraint and normalize its unscoped empty form.
 */
function graphScope(request: FastifyRequest): GraphReadScope {
  const tenantId = (request.query as { tenantId?: unknown }).tenantId;
  return {
    tenantId: typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : undefined,
    allowedTenantIds: request.tenants?.length ? request.tenants : undefined,
    readerRole: readerRoleOf(request),
  };
}

function isReadable(memoryRepo: MemoryRepository, id: string, scope: GraphReadScope): boolean {
  const memory = memoryRepo.findById(id);
  return (
    memory !== null &&
    (scope.tenantId === undefined || memory.tenantId === scope.tenantId) &&
    (scope.allowedTenantIds === undefined || scope.allowedTenantIds.includes(memory.tenantId)) &&
    isAudienceVisibleToRole(memory.metadata.audience, scope.readerRole)
  );
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

        const scope = graphScope(request);
        if (!isReadable(memoryRepo, id, scope)) {
          throw notFound(`Memory ${id} not found`);
        }

        const neighbors: Neighbor[] = linksRepo
          .neighbors(id, scope)
          .filter((n) => isReadable(memoryRepo, n.memoryId, scope));
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

        const scope = graphScope(request);
        if (!isReadable(memoryRepo, id, scope)) {
          throw notFound(`Memory ${id} not found`);
        }

        const nodes: GraphNode[] = linksRepo
          .traverse(id, depth, scope)
          .filter((n) => isReadable(memoryRepo, n.memoryId, scope));
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
