import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { isAgentRequest, readerRoleOf } from '../middleware/api-key-auth.js';
import type { HoldService } from '../services/hold-service.js';
import type { IndexRefresher } from '../services/index-refresher.js';

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ApiError) {
    return reply
      .status(err.statusCode)
      .send({ error: err.message, ...(err.code !== undefined ? { code: err.code } : {}) });
  }
  throw err;
}

/** Self-declared actor kind: only the closed `ai` / `system` values are honored. */
function declaredActorType(request: FastifyRequest): 'human' | 'ai' | 'system' {
  const body = (request.body ?? {}) as { actorType?: unknown };
  return body.actorType === 'ai' || body.actorType === 'system' ? body.actorType : 'human';
}

/**
 * Register the human-escalation hold routes (Epic K bead K6). All admin-only.
 *
 * GET  /api/holds                          — list open holds (200 | 400 | 403)
 * POST /api/holds/:candidateId/recommend   — attach a recommendation; changes no state
 * POST /api/holds/:candidateId/resolve     — a PERSON releases or rejects a hold
 */
export function registerHoldRoutes(
  app: FastifyInstance,
  service: HoldService,
  indexRefresher?: IndexRefresher,
): void {
  app.get(
    '/api/holds',
    {
      schema: {
        tags: ['holds'],
        summary: 'List open human-escalation holds (admin-only)',
        description:
          'Candidates the deterministic pipeline put on a bounded hold because an audience or ' +
          'secret question could be detected but not decided. Returns ids, titles, audience ' +
          'tiers, trigger names, pattern ids, the expiry and any attached recommendations — ' +
          'never candidate content. Holds that declare an audience above the caller’s standing ' +
          'are omitted and counted in `hiddenAboveStanding`. Requires `tenantId`.',
      },
    },
    async (request, reply) => {
      try {
        // The write gate covers mutations only; lock this read to admin here.
        if (request.role !== 'admin') {
          throw new ApiError(403, 'The hold queue is admin-only.');
        }
        const { tenantId } = request.query as { tenantId?: string };
        return reply.send(service.list(tenantId, readerRoleOf(request)));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/api/holds/:candidateId/recommend',
    {
      schema: {
        tags: ['holds'],
        summary: 'Attach a recommendation to a hold (admin-only; changes no state)',
        description:
          'The one thing a model or agent may do to a hold. Writes a `hold_recommended` audit ' +
          'receipt naming the acting token; the candidate’s status, audience and durable memory ' +
          'are untouched. Body: { verdict: release|reject, audience?, reasoning, actorType? }. ' +
          '404 if the candidate is not on hold, 422 if the hold has expired or already carries ' +
          'the maximum number of recommendations.',
      },
    },
    async (request, reply) => {
      try {
        const { candidateId } = request.params as { candidateId: string };
        const { tenantId } = request.query as { tenantId?: string };
        const body = (request.body ?? {}) as {
          verdict?: unknown;
          audience?: unknown;
          reasoning?: unknown;
        };
        // An agent token is always recorded as `ai`, whatever the body claims.
        const actorType = isAgentRequest(request) ? 'ai' : declaredActorType(request);
        const result = service.recommend(
          candidateId,
          tenantId,
          readerRoleOf(request),
          { type: actorType, id: request.actor ?? 'admin' },
          body,
        );
        return reply.status(200).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/api/holds/:candidateId/resolve',
    {
      schema: {
        tags: ['holds'],
        summary: 'Resolve a hold: release with a chosen audience, or reject (a person, admin-only)',
        description:
          'A human decision. An agent token, or a request that declares actorType ai/system, is ' +
          'refused 403 `human_required` and nothing changes. `release` re-runs the whole ' +
          'deterministic gate (disclosure, dedup, redaction, origin, import exclusion, policy) ' +
          'and promotes with the chosen audience; a secret, a duplicate or a flag the hold does ' +
          'not cover is refused 422. An audience wider than the recommended tier needs ' +
          '`acknowledgeWider: true`. `reject` retires the candidate (the row is kept). Either ' +
          'way a hash-chained `hold_resolved` receipt is written in the same transaction. ' +
          'A hold past its expiry is closed unpromoted and refused 422 `hold_expired`. ' +
          'Body: { resolution: release|reject, audience?, reason, acknowledgeWider? }.',
      },
    },
    async (request, reply) => {
      try {
        const { candidateId } = request.params as { candidateId: string };
        const { tenantId } = request.query as { tenantId?: string };
        if (isAgentRequest(request) || declaredActorType(request) !== 'human') {
          throw new ApiError(
            403,
            'Only a person resolves a hold. An agent may attach a recommendation ' +
              '(POST /api/holds/:candidateId/recommend). Nothing was changed.',
            'human_required',
          );
        }
        const body = (request.body ?? {}) as {
          resolution?: unknown;
          audience?: unknown;
          reason?: unknown;
          acknowledgeWider?: unknown;
        };
        const result = service.resolve(
          candidateId,
          tenantId,
          readerRoleOf(request),
          { type: 'human', id: request.actor ?? 'admin' },
          body,
        );

        // A release promoted a memory: refresh the index, best-effort, exactly
        // as POST /api/candidates/:id/promote does. The promotion is durable
        // whether or not the refresh completes.
        if (result.resolution === 'released' && indexRefresher !== undefined && tenantId) {
          try {
            const refreshed = await indexRefresher.refreshAfterPromotion(tenantId);
            if (!refreshed.ok) {
              request.log.warn(
                { tenantId, skipped: refreshed.skipped, error: refreshed.error },
                'post-release index refresh did not complete; memory searchable after next cycle',
              );
            }
          } catch (refreshErr) {
            request.log.warn(
              { tenantId, err: refreshErr },
              'post-release index refresh threw; memory searchable after next cycle',
            );
          }
        }
        return reply.status(200).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
