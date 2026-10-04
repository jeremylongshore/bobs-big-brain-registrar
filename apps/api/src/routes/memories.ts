import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MemoryLifecycleState } from '@qmd-team-intent-kb/schema';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import type { MemoryRepository } from '@qmd-team-intent-kb/store';
import { resolveWikiLinks } from '@qmd-team-intent-kb/curator';
import { ApiError } from '../errors.js';
import type { MemoryService } from '../services/memory-service.js';
import { isAudienceVisibleToRole } from '@qmd-team-intent-kb/common';
import { readerRoleOf } from '../middleware/api-key-auth.js';

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
 * Enforce claim-level audience on a single fetched record (K2). A memory whose
 * audience is narrower than the caller's read standing answers 404 — the same
 * shape as a missing id, so its existence is not disclosed by enumeration.
 */
function assertAudienceVisible(request: FastifyRequest, memory: CuratedMemory): void {
  if (!isAudienceVisibleToRole(memory.metadata.audience, readerRoleOf(request))) {
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
 * POST /api/memories/:id/narrow-audience  — governed audience narrowing (200 | 400 | 404)
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
      const role = readerRoleOf(request);
      const memories = service
        .list(tenantId)
        .filter((m) => isAudienceVisibleToRole(m.metadata.audience, role));
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
        if (!isAudienceVisibleToRole(memory.metadata.audience, readerRoleOf(request))) {
          return reply.status(404).send({ error: `No memory found with hash ${hash}` });
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
        assertAudienceVisible(request, memory);

        if (query.resolve_links === 'true' && memoryRepo) {
          const role = readerRoleOf(request);
          const { resolvedContent } = resolveWikiLinks(memory.content, (slug) => {
            const matches = memoryRepo.searchByText(slug);
            // A link never resolves to a memory the caller may not read (K2).
            const match = matches.find(
              (m) =>
                m.title.toLowerCase() === slug.toLowerCase() &&
                isAudienceVisibleToRole(m.metadata.audience, role),
            );
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

        // An admin may not transition (and so read back) an owner-only memory (K2).
        assertAudienceVisible(request, service.getById(id));

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

  // POST /api/memories/:id/narrow-audience — governed audience narrowing (K3)
  app.post(
    '/api/memories/:id/narrow-audience',
    {
      schema: {
        tags: ['memories'],
        summary: 'Narrow a memory’s audience with a receipted audit event',
        description:
          'Governed narrowing only: tenant → admins → owner. Widening, an equal tier and an unknown tier are refused (400). Writes an `audience_narrowed` audit event with {from, to} in the same transaction as the change; the actor is the authenticated caller. Body: { to, reason }. Admin only.',
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        // A caller may not narrow a memory they cannot read, in another tenant
        // or above their read standing — both answer 404, like a missing id.
        const memory = service.getById(id);
        assertTenantVisible(request, memory);
        assertAudienceVisible(request, memory);
        const narrowed = service.narrowAudience(id, request.body, request.actor ?? 'unknown');
        return reply.send(narrowed);
      } catch (err) {
        if (err instanceof ApiError) {
          return reply
            .status(err.statusCode)
            .send({ error: err.message, ...(err.code !== undefined ? { code: err.code } : {}) });
        }
        throw err;
      }
    },
  );

  // POST /api/memories/:id/recategorize — governed in-place category correction (5bm.7)
  app.post(
    '/api/memories/:id/recategorize',
    {
      schema: {
        tags: ['memories'],
        summary: 'Correct a memory’s category in place with a receipted audit event',
        description:
          'Governed recategorization: updates category without supersession, writing a `recategorized` audit event with {fromCategory, toCategory}. Body: { category, reason, actor }.',
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        // Same audience gate as transition: the response carries the memory (K2).
        assertAudienceVisible(request, service.getById(id));
        const memory = service.recategorize(id, request.body);
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
