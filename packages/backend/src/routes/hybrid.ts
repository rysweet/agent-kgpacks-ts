// @kgpacks/backend — hybrid-search route. `GET /api/v1/hybrid-search`.

import type { FastifyInstance } from 'fastify';

import { rateLimitConfig, type ServerContext } from '../context.js';
import { hybridQuerySchema } from '../schemas.js';
import { hybridSearch } from '../services/hybrid.js';

interface HybridQuery {
  query: string;
  category?: string;
  max_hops: number;
  limit: number;
}

export function registerHybridRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: HybridQuery }>(
    '/api/v1/hybrid-search',
    {
      schema: { querystring: hybridQuerySchema },
      config: rateLimitConfig(ctx, ctx.config.rateLimits.hybrid),
    },
    async (request, reply) => {
      reply.header('Cache-Control', `public, max-age=${ctx.config.cacheTtl.default}`);
      const { query, category, max_hops, limit } = request.query;
      return ctx.manager.withConnection((conn) =>
        hybridSearch(conn, { query, category: category ?? null, maxHops: max_hops, limit }),
      );
    },
  );
}
