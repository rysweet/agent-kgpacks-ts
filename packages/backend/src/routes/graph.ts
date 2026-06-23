// @kgpacks/backend — graph route. `GET /api/v1/graph`.

import type { FastifyInstance } from 'fastify';

import { rateLimitConfig, type ServerContext } from '../context.js';
import { graphQuerySchema } from '../schemas.js';
import { getGraphNeighbors } from '../services/graph.js';

interface GraphQuery {
  article: string;
  depth: number;
  limit: number;
  category?: string;
}

export function registerGraphRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: GraphQuery }>(
    '/api/v1/graph',
    {
      schema: { querystring: graphQuerySchema },
      config: rateLimitConfig(ctx, ctx.config.rateLimits.graph),
    },
    async (request, reply) => {
      reply.header('Cache-Control', `public, max-age=${ctx.config.cacheTtl.default}`);
      const { article, depth, limit, category } = request.query;
      return ctx.manager.withConnection((conn) =>
        getGraphNeighbors(conn, { article, depth, limit, category: category ?? null }),
      );
    },
  );
}
