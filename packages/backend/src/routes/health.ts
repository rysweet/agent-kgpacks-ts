// @kgpacks/backend — health route.
//
// `GET /health` (unprefixed, never rate-limited). Probes database reachability
// with a trivial `RETURN 1` query and returns `200` healthy / `503` unhealthy,
// always `no-store`. Ported from the reference `main.health_check`.

import type { FastifyInstance } from 'fastify';

import { nowIso } from '../errors.js';
import type { ServerContext } from '../context.js';
import type { HealthResponse } from '../types.js';

export function registerHealthRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/health', async (_request, reply) => {
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');

    let database = 'disconnected';
    let status = 'unhealthy';
    try {
      await ctx.manager.withConnection(async (conn) => {
        await conn.run('RETURN 1 AS test');
      });
      database = 'connected';
      status = 'healthy';
    } catch {
      // Reported as 503 below.
    }

    const body: HealthResponse = {
      status,
      version: ctx.config.apiVersion,
      database,
      timestamp: nowIso(),
    };
    if (status !== 'healthy') reply.code(503);
    return body;
  });
}
