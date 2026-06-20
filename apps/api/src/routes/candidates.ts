import type { FastifyInstance } from 'fastify';
import { ApiError, badRequest } from '../errors.js';
import type { CandidateService } from '../services/candidate-service.js';
import type { PromotionService } from '../services/promotion-service.js';

/**
 * Register candidate intake, retrieval, and promotion routes.
 *
 * POST   /api/candidates              — intake a new candidate (201)
 * POST   /api/candidates/:id/promote  — promote to a governed memory (200 | admin-only)
 * GET    /api/candidates/:id          — retrieve by UUID (200 | 404)
 * GET    /api/candidates              — list by tenantId query param (200 | 400)
 */
export function registerCandidateRoutes(
  app: FastifyInstance,
  service: CandidateService,
  promotionService: PromotionService,
): void {
  app.post(
    '/api/candidates',
    {
      schema: {
        tags: ['candidates'],
        summary: 'Intake a new memory candidate',
        description:
          'Accepts a candidate payload from a Claude Code session and stores it in the inbox.',
      },
    },
    async (request, reply) => {
      try {
        const candidate = service.intake(request.body);
        return reply.status(201).send(candidate);
      } catch (err) {
        if (err instanceof ApiError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/candidates/:id/promote',
    {
      schema: {
        tags: ['candidates'],
        summary: 'Promote a candidate to a governed memory (admin-only)',
        description:
          'Runs the full governance path (dedup → policy → promote) and atomically turns the ' +
          'inbox candidate into a curated memory, writing the promotion audit event. Admin-only ' +
          '(write gate). Returns 404 if the candidate is missing, 422 if it is already promoted ' +
          'or policy rejects/flags it (the candidate is left in the inbox), 400 if tenantId is missing.',
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const { tenantId } = request.query as { tenantId?: string };
        if (tenantId === undefined || tenantId.trim().length === 0) {
          throw badRequest('tenantId query parameter is required');
        }
        const memory = promotionService.promoteCandidate(id, tenantId);
        return reply.status(200).send(memory);
      } catch (err) {
        if (err instanceof ApiError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.get(
    '/api/candidates/:id',
    {
      schema: {
        tags: ['candidates'],
        summary: 'Retrieve a candidate by UUID',
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const candidate = service.getById(id);
        return reply.send(candidate);
      } catch (err) {
        if (err instanceof ApiError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.get(
    '/api/candidates',
    {
      schema: {
        tags: ['candidates'],
        summary: 'List candidates for a tenant',
        description: 'Requires `tenantId` query param. Returns 400 if missing.',
      },
    },
    async (request, reply) => {
      try {
        const { tenantId } = request.query as { tenantId?: string };
        const candidates = service.list(tenantId);
        return reply.send(candidates);
      } catch (err) {
        if (err instanceof ApiError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
