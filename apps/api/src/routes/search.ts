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
