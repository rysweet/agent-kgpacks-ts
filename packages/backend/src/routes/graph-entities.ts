// @kgpacks/backend — entity-graph route. `GET /api/v1/graph/entities`.
//
// Exposes the entity neighborhood over Entity / HAS_ENTITY / ENTITY_RELATION.
// Request validation (required `entity`, bounded `depth` 1..3 and `limit` 1..200,
// enum `mode`) is enforced by the JSON schema and rendered as the standard 400
// envelope; an unknown seed entity surfaces as 404 from the service.

import type { FastifyInstance } from 'fastify';

import { rateLimitConfig, type ServerContext } from '../context.js';
import { graphEntitiesQuerySchema } from '../schemas.js';
import { getEntityGraph } from '../services/graph-entities.js';

interface GraphEntitiesQuery {
  entity: string;
  depth: number;
  limit: number;
  type?: string;
  mode: 'auto' | 'co-occurrence' | 'relation';
}

export function registerGraphEntitiesRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: GraphEntitiesQuery }>(
    '/api/v1/graph/entities',
    {
      schema: { querystring: graphEntitiesQuerySchema },
      config: rateLimitConfig(ctx, ctx.config.rateLimits.graph),
    },
    async (request, reply) => {
      reply.header('Cache-Control', `public, max-age=${ctx.config.cacheTtl.default}`);
      const { entity, depth, limit, type, mode } = request.query;
      return ctx.manager.withConnection((conn) =>
        getEntityGraph(conn, { entity, depth, limit, type, mode }),
      );
    },
  );
}
