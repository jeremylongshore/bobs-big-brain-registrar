import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { CandidateRepository } from '@qmd-team-intent-kb/store';
import { assertDisclosureClean, DisclosureRejectedError } from '@qmd-team-intent-kb/common';
import {
  previewSourceGovernance,
  applySourceGovernance,
  SourceGovernancePlan,
  type SourceGovernanceContext,
} from '@qmd-team-intent-kb/curator';
import type { TokenRegistry } from '../auth/token-registry.js';
import type { IndexRefresher } from '../services/index-refresher.js';
import { ApiError, notFound, unprocessable } from '../errors.js';

const receiverIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const requestSchema = z.discriminatedUnion('action', [
  z
    .object({
      version: z.literal(1),
      tenantId: receiverIdSchema,
      action: z.literal('preview'),
      assertion: z.string().min(1).max(16384),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      tenantId: receiverIdSchema,
      action: z.literal('apply'),
      assertion: z.string().min(1).max(16384),
      plan: SourceGovernancePlan,
    })
    .strict(),
]);
const ingressId = 'api-source-governance-v1';

export interface SourceGovernanceInstallation {
  receiverId: string;
  /** Trusted server clock; request fields never select time. */
  now?: () => string;
}

/** Explicit evidence route over existing canonical intake; no new capture bypass. */
export function registerSourceGovernanceRoutes(
  app: FastifyInstance,
  db: Database.Database,
  registry: TokenRegistry,
  installation: SourceGovernanceInstallation | undefined,
  configuration: Omit<SourceGovernanceContext, 'readReceiver'>,
  indexRefresher?: IndexRefresher,
): void {
  if (installation !== undefined) receiverIdSchema.parse(installation.receiverId);
  const authenticate = (request: FastifyRequest, tenantId?: string) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const identity = token === undefined ? undefined : registry.resolve(token);
    if (
      identity?.role !== 'admin' ||
      (tenantId !== undefined && identity.tenants?.length && !identity.tenants.includes(tenantId))
    )
      throw new ApiError(
        403,
        'Source governance requires an authenticated admin for this tenant.',
        'source_authorization_required',
      );
    return identity;
  };
  app.get('/api/candidates/source-governance-capabilities', async (request, reply) => {
    try {
      authenticate(request);
      return {
        version: 1,
        enabled: installation !== undefined,
        ingressId,
        candidateIntake: '/api/candidates',
        endpoint: '/api/candidates/:id/source-governance',
        actions: ['preview', 'apply'],
        storesAssertion: false,
      };
    } catch (error) {
      if (error instanceof ApiError)
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      throw error;
    }
  });
  app.post('/api/candidates/:id/source-governance', async (request, reply) => {
    try {
      authenticate(request);
      const parsed = requestSchema.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          400,
          'Invalid source-governance v1 envelope.',
          'invalid_source_envelope',
        );
      const body = parsed.data;
      const actor = authenticate(request, body.tenantId).actor;
      if (installation === undefined)
        throw new ApiError(
          503,
          'Configure the server receiver and enroll this ingress before using source governance.',
          'source_ingress_unavailable',
        );
      const { id } = request.params as { id: string };
      const candidate = new CandidateRepository(db).findById(id);
      if (!candidate || candidate.tenantId !== body.tenantId)
        throw notFound('Candidate not found in this tenant.');
      // Preserve the API promotion hard floor even with disabled tenant policy.
      try {
        assertDisclosureClean(candidate);
      } catch (error) {
        if (error instanceof DisclosureRejectedError)
          throw unprocessable(
            'Source governance refused disallowed disclosure material.',
            'source_disclosure_rejected',
          );
        throw error;
      }
      const context: SourceGovernanceContext = {
        ...configuration,
        readReceiver: () => {
          if (authenticate(request, body.tenantId).actor !== actor)
            throw new ApiError(
              403,
              'Source-governance identity changed.',
              'source_authorization_required',
            );
          return {
            receiverId: installation.receiverId,
            tenantId: body.tenantId,
            ingressId,
            now: installation.now?.() ?? new Date().toISOString(),
          };
        },
      };
      if (body.action === 'preview')
        return { version: 1, plan: previewSourceGovernance(id, body.assertion, db, context) };
      if (body.plan.candidateId !== id || body.plan.tenantId !== body.tenantId)
        throw new ApiError(
          400,
          'Plan does not match the requested candidate and tenant.',
          'invalid_source_envelope',
        );
      const result = applySourceGovernance(body.plan, body.assertion, db, context);
      // Alias restrictions can invalidate old index entries even without promotion.
      let indexRefresh = 'not-configured';
      if (indexRefresher !== undefined) {
        try {
          indexRefresh = (await indexRefresher.refreshAfterPromotion(body.tenantId)).ok
            ? 'complete'
            : 'pending';
        } catch {
          indexRefresh = 'pending';
        }
      }
      return { version: 1, ...result, indexRefresh };
    } catch (error) {
      if (error instanceof ApiError)
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      // Never expose raw assertions, candidate text or registry/parser details.
      return reply.code(409).send({
        code: 'source_governance_refused',
        error:
          'Evidence or governance state did not verify. Obtain current source evidence and preview again; no partial governance change was committed.',
      });
    }
  });
}
