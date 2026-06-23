// @kgpacks/backend — semantic-search route. `GET /api/v1/search`.

import type { FastifyInstance } from 'fastify';

import { rateLimitConfig, type ServerContext } from '../context.js';
import { searchQuerySchema } from '../schemas.js';
import { semanticSearch } from '../services/search.js';

interface SearchQuery {
  query: string;
  category?: string;
  limit: number;
  threshold: number;
}

export function registerSearchRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: SearchQuery }>(
    '/api/v1/search',
    {
      schema: { querystring: searchQuerySchema },
      config: rateLimitConfig(ctx, ctx.config.rateLimits.search),
    },
    async (request, reply) => {
      reply.header('Cache-Control', `public, max-age=${ctx.config.cacheTtl.default}`);
      const { query, category, limit, threshold } = request.query;
      return ctx.manager.withConnection((conn) =>
        semanticSearch(conn, { query, category: category ?? null, limit, threshold }),
      );
    },
  );
}
