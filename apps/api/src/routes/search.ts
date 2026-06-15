import type { FastifyInstance } from 'fastify';
import { SearchQuery } from '@qmd-team-intent-kb/schema';
import { ApiError } from '../errors.js';
import type { SearchService } from '../services/search-service.js';

/**
 * Register the search endpoint.
 *
 * POST /api/search — full-text search with freshness reranking
 */
export function registerSearchRoutes(app: FastifyInstance, service: SearchService): void {
  app.post(
    '/api/search',
    {
      schema: {
        tags: ['search'],
        summary: 'Full-text search over curated memories',
        description:
          'Applies freshness reranking. Body is validated against the SearchQuery schema.',
      },
    },
    async (request, reply) => {
      try {
        const parsed = SearchQuery.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: `Invalid search query: ${parsed.error.message}` });
        }

        const result = await service.search(parsed.data);

        // Per-read access audit. Deliberately a structured access-log line, NOT
        // a governance AuditEvent — the hash-chained memory audit trail records
        // governance state changes and must stay pure for `ico audit verify`.
        // This gives "who queried what, and what citations came back" from day
        // one without contaminating that chain.
        request.log.info(
          {
            event: 'query-access',
            actor: request.actor ?? 'anonymous',
            query: parsed.data.query,
            scope: parsed.data.scope,
            resultCount: result.totalCount,
            citations: result.hits
              .map((h) => h.citation)
              .filter((c): c is string => typeof c === 'string'),
          },
          'teamkb query',
        );

        return reply.send(result);
      } catch (err) {
        if (err instanceof ApiError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
