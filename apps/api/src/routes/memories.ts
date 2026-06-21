import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MemoryLifecycleState } from '@qmd-team-intent-kb/schema';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import type { MemoryRepository } from '@qmd-team-intent-kb/store';
import { resolveWikiLinks } from '@qmd-team-intent-kb/curator';
import { ApiError } from '../errors.js';
import type { MemoryService } from '../services/memory-service.js';

/**
 * Enforce token→tenant binding on a single-record fetch (EPIC 0,
 * compile-then-govern-c5k). The `:id` / `by-hash` lookups carry no tenantId in
 * the request, so the preHandler tenancy guard cannot bind them up-front —
 * instead we check the FETCHED record's tenantId against the token's allowlist.
 * Unscoped tokens (empty allowlist, or dev no-auth) are unaffected. Returns 404
 * (not 403) on a cross-tenant hit so the existence of another tenant's record
 * is not disclosed by enumeration.
 */
function assertTenantVisible(request: FastifyRequest, memory: CuratedMemory): void {
  const allowed = request.tenants;
  if (allowed === undefined || allowed.length === 0) return;
  if (!allowed.includes(memory.tenantId)) {
    throw new ApiError(404, `Memory ${memory.id} not found`);
  }
}

/**
 * Register curated memory retrieval and lifecycle routes.
 *
 * GET  /api/memories                      — list by tenantId query (200)
 * GET  /api/memories/by-hash/:hash        — find by content hash (200 | 404)
 * GET  /api/memories/:id                  — retrieve by UUID (200 | 404)
 * POST /api/memories/:id/transition       — lifecycle transition (200 | 400 | 404)
 *
 * Note: by-hash must be registered before :id so Fastify does not treat
 * "by-hash" as a UUID parameter value.
 */
export function registerMemoryRoutes(
  app: FastifyInstance,
  service: MemoryService,
  memoryRepo?: MemoryRepository,
): void {
  app.get(
    '/api/memories',
    {
      schema: {
        tags: ['memories'],
        summary: 'List curated memories for a tenant',
      },
    },
    async (request, reply) => {
      const { tenantId } = request.query as { tenantId?: string };
      const memories = service.list(tenantId);
      return reply.send(memories);
    },
  );

  app.get(
    '/api/memories/by-hash/:hash',
    {
      schema: {
        tags: ['memories'],
        summary: 'Look up a curated memory by content hash',
      },
    },
    async (request, reply) => {
      try {
        const { hash } = request.params as { hash: string };
        const memory = service.findByHash(hash);
        if (memory === null) {
          return reply.status(404).send({ error: `No memory found with hash ${hash}` });
        }
        assertTenantVisible(request, memory);
        return reply.send(memory);
      } catch (err) {
        if (err instanceof ApiError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.get(
    '/api/memories/:id',
    {
      schema: {
        tags: ['memories'],
        summary: 'Retrieve a curated memory by UUID',
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = request.query as { resolve_links?: string };
        const memory = service.getById(id);
        assertTenantVisible(request, memory);

        if (query.resolve_links === 'true' && memoryRepo) {
          const { resolvedContent } = resolveWikiLinks(memory.content, (slug) => {
            const matches = memoryRepo.searchByText(slug);
            const match = matches.find((m) => m.title.toLowerCase() === slug.toLowerCase());
            return match ? { id: match.id, title: match.title } : null;
          });
          return reply.send({ ...memory, content: resolvedContent });
        }

        return reply.send(memory);
      } catch (err) {
        if (err instanceof ApiError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/memories/:id/transition',
    {
      schema: {
        tags: ['memories'],
        summary: 'Transition a memory to a new lifecycle state',
        description:
          'Valid transitions are defined in the lifecycle state machine: active → {deprecated, superseded, archived}; deprecated → {active, archived}; superseded → {archived}; archived is terminal.',
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = request.body as { to?: unknown } & Record<string, unknown>;
        const toRaw = body['to'];

        const toParsed = MemoryLifecycleState.safeParse(toRaw);
        if (!toParsed.success) {
          return reply
            .status(400)
            .send({ error: `Invalid lifecycle state: ${String(toRaw ?? 'undefined')}` });
        }

        // Forward the rest of the body as the TransitionRequest
        const { to: _to, ...transitionBody } = body;
        const memory = service.transition(id, toParsed.data, transitionBody);
        return reply.send(memory);
      } catch (err) {
        if (err instanceof ApiError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
