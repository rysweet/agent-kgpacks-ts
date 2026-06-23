// @kgpacks/backend — server assembly.
//
// `buildServer(options)` is the single public seam: it returns a fully wired but
// not-yet-listening Fastify instance — CORS, security-header hook, per-route rate
// limiting, all `/api/v1` routes, `/health`, and the global error / not-found
// handlers that normalize every failure into the standard envelope. External
// dependencies (database, agent, embedder) are injected, so the server runs
// identically in production (real deps) and tests (offline fakes).

import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { CopilotAgent } from '@kgpacks/agent';
import { Database } from '@kgpacks/db';
import { BgeEmbedder } from '@kgpacks/embeddings';
import type { Embedder } from '@kgpacks/query';
import Fastify, { type FastifyInstance } from 'fastify';

import { loadConfig, mergeConfig, type SettingsOverride } from './config.js';
import { ConnectionManager } from './connection.js';
import type { ServerContext } from './context.js';
import { ApiError, errorEnvelope } from './errors.js';
import { makeKeyGenerator } from './rate-limit-key.js';
import { registerArticlesRoutes } from './routes/articles.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerGraphRoute } from './routes/graph.js';
import { registerHealthRoute } from './routes/health.js';
import { registerHybridRoute } from './routes/hybrid.js';
import { registerSearchRoute } from './routes/search.js';
import { StatsCache } from './services/article.js';
import type { ChatAgent } from './services/chat.js';

/** Options for {@link buildServer}. */
export interface BuildServerOptions {
  /** A constructed `Database`, or a path / `:memory:` string the server opens. */
  database: Database | string;
  /** Synthesis agent for chat. When omitted, the chat endpoints report `503`. */
  agent?: ChatAgent;
  /** Query embedder for chat retrieval. Defaults to the validated BGE embedder. */
  embedder?: Embedder;
  /** Override the global rate-limit toggle (else `WIKIGR_RATE_LIMIT_ENABLED`). */
  rateLimit?: boolean;
  /** Shallow override of `loadConfig()` (top-level and nested fields optional). */
  config?: SettingsOverride;
  /** Standard Fastify logger option. Defaults to off. */
  logger?: boolean | object;
  /** Environment source for `loadConfig`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-XSS-Protection': '0',
  'Content-Security-Policy': "default-src 'none'",
};

function resolveDatabase(database: Database | string): Database {
  return typeof database === 'string' ? new Database(database) : database;
}

/** Builds a configured (but not listening) Fastify instance. */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const config = mergeConfig(loadConfig(options.env), options.config);
  const rateLimitEnabled = options.rateLimit ?? config.rateLimitEnabled;

  const database = resolveDatabase(options.database);
  const manager = new ConnectionManager(database);
  const embedder = options.embedder ?? new BgeEmbedder();

  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
  });

  if (rateLimitEnabled) {
    await app.register(rateLimit, {
      global: false,
      keyGenerator: makeKeyGenerator(config.trustedProxies),
      // The plugin throws this value; an ApiError lets the global handler render
      // the standard 429 envelope (see setErrorHandler below).
      errorResponseBuilder: () => new ApiError(429, 'RATE_LIMITED', 'Rate limit exceeded'),
    });
  }

  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.statusCode).send(errorEnvelope(error.code, error.message, error.details));
      return;
    }

    const validation = (error as { validation?: ValidationEntry[] }).validation;
    if (Array.isArray(validation) && validation.length > 0) {
      const first = validation[0];
      if (first.keyword === 'required') {
        const field = first.params?.missingProperty ?? 'parameter';
        reply
          .code(400)
          .send(errorEnvelope('MISSING_PARAMETER', `Missing required parameter: ${field}`));
        return;
      }
      reply
        .code(400)
        .send(errorEnvelope('INVALID_PARAMETER', `Invalid parameter: ${fieldName(first)}`));
      return;
    }

    if ((error as { statusCode?: number }).statusCode === 429) {
      reply.code(429).send(errorEnvelope('RATE_LIMITED', 'Rate limit exceeded'));
      return;
    }

    request.log.error(error);
    reply.code(500).send(errorEnvelope('INTERNAL_ERROR', 'An unexpected error occurred'));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(errorEnvelope('NOT_FOUND', `Route ${request.method}:${request.url} not found`));
  });

  const ctx: ServerContext = {
    manager,
    config,
    agent: options.agent,
    embedder,
    statsCache: new StatsCache(),
    rateLimitEnabled,
  };

  registerHealthRoute(app, ctx);
  registerChatRoutes(app, ctx);
  registerSearchRoute(app, ctx);
  registerHybridRoute(app, ctx);
  registerGraphRoute(app, ctx);
  registerArticlesRoutes(app, ctx);

  return app;
}

interface ValidationEntry {
  keyword: string;
  instancePath?: string;
  params?: { missingProperty?: string };
}

function fieldName(entry: ValidationEntry): string {
  if (entry.instancePath && entry.instancePath.length > 1) {
    return entry.instancePath.replace(/^\//, '');
  }
  return entry.params?.missingProperty ?? 'parameter';
}

// Re-export so consumers don't need to know that CopilotAgent satisfies ChatAgent.
export { CopilotAgent };
