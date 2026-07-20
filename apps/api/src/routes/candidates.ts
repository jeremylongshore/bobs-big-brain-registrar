import type { FastifyInstance } from 'fastify';
import { ApiError, badRequest } from '../errors.js';
import type { CandidateService } from '../services/candidate-service.js';
import type { PromotionService } from '../services/promotion-service.js';
import type { IndexRefresher } from '../services/index-refresher.js';

/**
 * Register candidate intake, retrieval, and promotion routes.
 *
 * POST   /api/candidates              — intake (201 created | 200 already_exists)
 * POST   /api/candidates/:id/promote  — promote to a governed memory (200 | admin-only)
 * POST   /api/candidates/:id/reject   — retire a reviewed candidate (200 | admin-only)
 * GET    /api/candidates/:id          — retrieve by UUID (200 | 404)
 * GET    /api/candidates              — list by tenantId (+ optional status) (200 | 400)
 */
export function registerCandidateRoutes(
  app: FastifyInstance,
  service: CandidateService,
  promotionService: PromotionService,
  indexRefresher?: IndexRefresher,
): void {
  app.post(
    '/api/candidates',
    {
      schema: {
        tags: ['candidates'],
        summary: 'Intake a new memory candidate',
        description:
          'Accepts a candidate payload from a Claude Code session and stores it in the inbox. ' +
          'Idempotent: re-send with the same id (session-stable / frozen outbox) or same content ' +
          'within the tenant returns the existing row. Response field `intake` is ' +
          '`created` (201) or `already_exists` (200) so callers can tell first land from collapse.',
      },
    },
    async (request, reply) => {
      try {
        // Thread the bearer-token identity into intake so the server — not the
        // client — owns author / trustLevel / tenantId / prePolicyFlags and the
        // quarantine marker (R8, compile-then-govern-jfv.6.7).
        const { candidate, intake } = service.intake(request.body, {
          actor: request.actor,
          role: request.role,
          tenants: request.tenants,
        });
        const status = intake === 'created' ? 201 : 200;
        return reply.status(status).send({ ...candidate, intake });
      } catch (err) {
        if (err instanceof ApiError) {
          // `code` is the stable machine-readable rejection class (H3 —
          // e.g. `unrecognized_channel`) so clients can branch without prose.
          return reply
            .status(err.statusCode)
            .send({ error: err.message, ...(err.code !== undefined ? { code: err.code } : {}) });
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
        // The acting reviewer: id is the SERVER-AUTHENTICATED token identity
        // (unspoofable — `teamkb-review-agent` for the nightly agent), so the
        // 'promoted' receipt is filterable by who approved it (014-AT-DECR #2).
        // `actorType`/`reason` are the only client-supplied fields (the agent
        // proxy sends `ai` + its verdict); actorType is constrained to the closed
        // AuthorType vocabulary so a bad hint can't break the audit schema parse.
        const body = (request.body ?? {}) as { reason?: string; actorType?: string };
        const actorType =
          body.actorType === 'ai' || body.actorType === 'system' ? body.actorType : 'human';
        const memory = promotionService.promoteCandidate(
          id,
          tenantId,
          { type: actorType, id: request.actor ?? 'admin' },
          typeof body.reason === 'string' ? body.reason : undefined,
        );

        // D1: the promotion transaction has COMMITTED (promote() is atomic —
        // R9), so trigger the export→reindex chain now, making the memory
        // searchable without waiting for the next daemon cycle. Awaited so the
        // 200 means "promoted AND absorbed" on the happy path; best-effort
        // because the memory is already durable — a failed refresh degrades to
        // "stale but promoted", which the D2 staleness gauge reports, and must
        // never turn a successful promotion into an error response.
        if (indexRefresher !== undefined) {
          try {
            const refreshed = await indexRefresher.refreshAfterPromotion(tenantId);
            if (!refreshed.ok) {
              request.log.warn(
                { tenantId, skipped: refreshed.skipped, error: refreshed.error },
                'post-promotion index refresh did not complete; memory searchable after next cycle',
              );
            }
          } catch (refreshErr) {
            request.log.warn(
              { tenantId, err: refreshErr },
              'post-promotion index refresh threw; memory searchable after next cycle',
            );
          }
        }

        return reply.status(200).send(memory);
      } catch (err) {
        if (err instanceof ApiError) {
          // `code` carries the stable rejection class (H1 — e.g.
          // `origin_token_invalid` when the provenance HMAC fails to verify).
          return reply
            .status(err.statusCode)
            .send({ error: err.message, ...(err.code !== undefined ? { code: err.code } : {}) });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/candidates/:id/reject',
    {
      schema: {
        tags: ['candidates'],
        summary: 'Retire a reviewed candidate as rejected (admin-only)',
        description:
          'Non-destructively marks a candidate `rejected` (the row survives — candidates are ' +
          'Tier-A source of truth) and writes an audit receipt naming the acting reviewer + ' +
          'reason. The agent-review "this is noise" verdict (jfv.8 / 014-AT-DECR). Admin-only ' +
          '(write gate). Requires a non-empty `reason` in the body; 404 if the candidate is ' +
          'missing, 400 if tenantId or reason is missing.',
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const { tenantId } = request.query as { tenantId?: string };
        if (tenantId === undefined || tenantId.trim().length === 0) {
          throw badRequest('tenantId query parameter is required');
        }
        const body = (request.body ?? {}) as { reason?: string; actorType?: string };
        if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
          throw badRequest('a non-empty reason is required to reject a candidate');
        }
        const actorType =
          body.actorType === 'ai' || body.actorType === 'system' ? body.actorType : 'human';
        promotionService.rejectCandidate(
          id,
          tenantId,
          { type: actorType, id: request.actor ?? 'admin' },
          body.reason,
        );
        return reply.status(200).send({ ok: true, candidateId: id, status: 'rejected' });
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
        summary: 'List candidates for a tenant, optionally by status',
        description:
          'Requires `tenantId`. Optional `status` narrows to one CandidateStatus ' +
          '(e.g. `quarantined` — the agent-review inbox queue). 400 if tenantId is ' +
          'missing or status is not a valid CandidateStatus.',
      },
    },
    async (request, reply) => {
      try {
        const { tenantId, status } = request.query as { tenantId?: string; status?: string };
        const candidates = service.list(tenantId, status);
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
