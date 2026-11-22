import type { FastifyInstance } from 'fastify';
import { executeReviewedStaleness } from '@qmd-team-intent-kb/curator';
import type { ReviewedStalenessInstallation } from '@qmd-team-intent-kb/curator';
import type { TokenRegistry } from '../auth/token-registry.js';
import { readerRoleOf, isAgentRequest } from '../middleware/api-key-auth.js';

/** Opt-in server configuration; the HTTP body contains only a reviewed manifest. */
export function registerReviewedStalenessRoutes(
  app: FastifyInstance,
  installation: ReviewedStalenessInstallation,
  registry: TokenRegistry,
): void {
  app.post(
    '/api/memories/reviewed-staleness',
    {
      schema: {
        tags: ['memories'],
        summary:
          'Settle one independently approved staleness manifest; downstream verification remains pending',
      },
    },
    async (request, reply) => {
      const header = request.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
      const result = executeReviewedStaleness(
        request.body,
        () => {
          // Re-resolve after any lock wait as well: an expired/revoked bearer or
          // the synthetic dev/admin middleware identity cannot authorize writes.
          const identity = token === undefined ? undefined : registry.resolve(token);
          return {
            authenticated: identity !== undefined,
            actor: identity?.actor ?? '',
            role: readerRoleOf({ role: identity?.role, owner: identity?.owner }),
            agent: identity === undefined || isAgentRequest(identity),
            tenants: identity?.tenants,
          };
        },
        installation,
      );
      return reply
        .status(result.ok ? 200 : result.failedStage === 'authorization' ? 403 : 409)
        .send(result);
    },
  );
}
