// @kgpacks/backend — articles router.
//
// `GET /api/v1/articles/:title`, `/autocomplete`, `/categories`, `/stats`.
// Ported from the reference `api/v1/articles` (+ the autocomplete handler that
// lives in `api/v1/search`). The `:title` path segment is URL-decoded by
// Fastify before reaching the handler.

import type { FastifyInstance } from 'fastify';

import { rateLimitConfig, type ServerContext } from '../context.js';
import { articleParamsSchema, autocompleteQuerySchema } from '../schemas.js';
import { getArticleDetails, getCategories, getStats } from '../services/article.js';
import { autocomplete } from '../services/search.js';

interface AutocompleteQuery {
  q: string;
  limit: number;
}

export function registerArticlesRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Params: { title: string } }>(
    '/api/v1/articles/:title',
    {
      schema: { params: articleParamsSchema },
      config: rateLimitConfig(ctx, ctx.config.rateLimits.articles),
    },
    async (request, reply) => {
      reply.header('Cache-Control', `public, max-age=${ctx.config.cacheTtl.article}`);
      const { title } = request.params;
      return ctx.manager.withConnection((conn) => getArticleDetails(conn, title));
    },
  );

  app.get<{ Querystring: AutocompleteQuery }>(
    '/api/v1/autocomplete',
    {
      schema: { querystring: autocompleteQuerySchema },
      config: rateLimitConfig(ctx, ctx.config.rateLimits.autocomplete),
    },
    async (request, reply) => {
      reply.header('Cache-Control', `public, max-age=${ctx.config.cacheTtl.default}`);
      const { q, limit } = request.query;
      return ctx.manager.withConnection((conn) => autocomplete(conn, q, limit));
    },
  );

  app.get(
    '/api/v1/categories',
    { config: rateLimitConfig(ctx, ctx.config.rateLimits.categories) },
    async (_request, reply) => {
      reply.header('Cache-Control', `public, max-age=${ctx.config.cacheTtl.default}`);
      return ctx.manager.withConnection((conn) => getCategories(conn));
    },
  );

  app.get(
    '/api/v1/stats',
    { config: rateLimitConfig(ctx, ctx.config.rateLimits.stats) },
    async (_request, reply) => {
      reply.header('Cache-Control', `public, max-age=${ctx.config.cacheTtl.stats}`);
      return ctx.manager.withConnection((conn) =>
        getStats(conn, ctx.config.databasePath, ctx.statsCache),
      );
    },
  );
}
