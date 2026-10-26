import type { FastifyInstance } from 'fastify';
import type { HealthService } from '../services/health-service.js';

/**
 * Register the health check route.
 * GET /api/health — returns liveness and database connectivity.
 */
export function registerHealthRoutes(app: FastifyInstance, service: HealthService): void {
  app.get(
    '/api/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness and database reachability probe',
        security: [],
        description:
          'Returns `healthy` with uptime and version when the database is reachable, `degraded` (503) otherwise.',
      },
    },
    async (_request, reply) => {
      const status = service.checkLiveness();
      const httpStatus = status.status === 'healthy' ? 200 : 503;
      return reply.status(httpStatus).send(status);
    },
  );
  app.get(
    '/api/health/diagnostics',
    {
      schema: {
        tags: ['health'],
        summary: 'Global operational diagnostics — unscoped administrators only',
        security: [{ bearerAuth: [] }],
        description:
          'Includes cross-tenant policy dormancy and index freshness. Requires an unscoped admin bearer token outside existing loopback development no-auth mode. Tenant-scoped tokens are refused, even when naming an allowed tenant.',
      },
    },
    async (request, reply) => {
      // These diagnostics aggregate across all tenants. A tenant selector does
      // not narrow the service query and must never widen a scoped token.
      if (request.role !== 'admin' || (request.tenants?.length ?? 0) > 0) {
        return reply.code(403).send({
          error: 'global_diagnostics_admin_required',
          message: 'Global diagnostics require an unscoped administrator.',
        });
      }
      const status = service.check();
      return reply.code(status.status === 'healthy' ? 200 : 503).send(status);
    },
  );
}
