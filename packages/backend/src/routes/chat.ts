// @kgpacks/backend — chat router. `POST /api/v1/chat` + `GET /api/v1/chat/stream`.
//
// Both share the chat pipeline (`runChat`). The blocking route returns a single
// `ChatResponse`; the SSE route streams `sources → token → done` (or one `error`).
// Ported from the reference `api/v1/chat`, including the agent-availability `503`,
// the pack-name validation, and the synthesis timeout. `query_type` is the stable
// `"vector_search"` label (see services/chat.ts).

import type { FastifyInstance } from 'fastify';

import { ApiError, errorEnvelope } from '../errors.js';
import { rateLimitConfig, type ServerContext } from '../context.js';
import { chatBodySchema, chatStreamQuerySchema } from '../schemas.js';
import { runChat, type ChatAgent } from '../services/chat.js';
import { sseStream, type SseEvent } from '../sse.js';
import type { ChatResponse } from '../types.js';
import { round1 } from '../util.js';

/** Allowed pack-name shape (reference `PACK_NAME_RE`). */
const PACK_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Sentinel distinguishing the synthesis-timeout path from a synthesis failure. */
class StreamTimeout extends Error {
  constructor() {
    super('stream synthesis timed out');
    this.name = 'StreamTimeout';
  }
}

interface ChatBody {
  question: string;
  pack?: string;
  max_results: number;
}

interface ChatStreamQuery {
  question: string;
  max_results: number;
}

/** Resolves the agent or throws the `503 AGENT_UNAVAILABLE` envelope error. */
function requireAgent(ctx: ServerContext): ChatAgent {
  if (ctx.agent === undefined) {
    throw new ApiError(
      503,
      'AGENT_UNAVAILABLE',
      'Chat agent is not available. No synthesis agent is configured.',
    );
  }
  return ctx.agent;
}

/** Phase-1 pack handling: validate the name, then report the pack as not found. */
function checkPack(pack: string | undefined): void {
  if (pack === undefined) return;
  if (!PACK_NAME_RE.test(pack)) {
    throw new ApiError(400, 'INVALID_PACK_NAME', 'Invalid pack name');
  }
  // Phase 1 serves only the default (injected) pack; any named pack is unknown.
  throw new ApiError(404, 'PACK_NOT_FOUND', 'Requested pack was not found');
}

export function registerChatRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post<{ Body: ChatBody }>(
    '/api/v1/chat',
    {
      schema: { body: chatBodySchema },
      config: rateLimitConfig(ctx, ctx.config.rateLimits.chat),
    },
    async (request): Promise<ChatResponse> => {
      const agent = requireAgent(ctx);
      const { question, pack, max_results } = request.body;
      checkPack(pack);

      const start = performance.now();
      try {
        const outcome = await ctx.manager.withConnection((conn) =>
          runChat(conn, { agent, embedder: ctx.embedder }, { question, maxResults: max_results }),
        );
        return {
          answer: outcome.answer,
          sources: outcome.sources,
          query_type: outcome.query_type,
          execution_time_ms: round1(performance.now() - start),
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'AGENT_ERROR', 'Agent encountered an error');
      }
    },
  );

  app.get<{ Querystring: ChatStreamQuery }>(
    '/api/v1/chat/stream',
    {
      schema: { querystring: chatStreamQuerySchema },
      config: rateLimitConfig(ctx, ctx.config.rateLimits.chat),
    },
    async (request, reply) => {
      // Agent-unavailable is a pre-stream 503 JSON envelope (not an `error` event).
      if (ctx.agent === undefined) {
        return reply
          .code(503)
          .send(
            errorEnvelope(
              'AGENT_UNAVAILABLE',
              'Chat agent is not available. No synthesis agent is configured.',
            ),
          );
      }
      const agent = ctx.agent;
      const { question, max_results } = request.query;
      const timeoutMs = ctx.config.streamTimeoutMs;

      reply.header('Content-Type', 'text/event-stream');
      reply.header('Cache-Control', 'no-cache');
      reply.header('Connection', 'keep-alive');
      reply.header('X-Accel-Buffering', 'no');

      const events = async function* (): AsyncGenerator<SseEvent> {
        const start = performance.now();
        const conn = await ctx.manager.getConnection();
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new StreamTimeout()), timeoutMs);
          });
          let outcome;
          try {
            outcome = await Promise.race([
              runChat(
                conn,
                { agent, embedder: ctx.embedder },
                { question, maxResults: max_results },
              ),
              timeout,
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }

          yield { event: 'sources', data: JSON.stringify(outcome.sources) };
          yield { event: 'token', data: outcome.answer };
          yield {
            event: 'done',
            data: JSON.stringify({
              query_type: outcome.query_type,
              execution_time_ms: round1(performance.now() - start),
            }),
          };
        } catch (error) {
          yield {
            event: 'error',
            data: error instanceof StreamTimeout ? 'TimeoutError' : 'AgentError',
          };
        } finally {
          conn.close();
        }
      };

      return reply.send(sseStream(() => events()));
    },
  );
}
