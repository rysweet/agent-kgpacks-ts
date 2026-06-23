// @kgpacks/backend — shared per-server context passed to route registrars.

import type { ChatAgent } from './services/chat.js';
import type { Embedder } from '@kgpacks/query';

import type { Settings } from './config.js';
import type { ConnectionManager } from './connection.js';
import type { StatsCache } from './services/article.js';

/** Dependencies and configuration shared by every route handler. */
export interface ServerContext {
  manager: ConnectionManager;
  config: Settings;
  /** Synthesis agent; when absent, the chat endpoints report `503`. */
  agent?: ChatAgent;
  embedder: Embedder;
  statsCache: StatsCache;
  /** Effective rate-limit toggle (after `options.rateLimit` / env resolution). */
  rateLimitEnabled: boolean;
}

/** Builds the Fastify per-route `config.rateLimit` block (omitted when disabled). */
export function rateLimitConfig(
  ctx: ServerContext,
  max: number,
): { rateLimit: { max: number; timeWindow: number } } | undefined {
  if (!ctx.rateLimitEnabled) return undefined;
  return { rateLimit: { max, timeWindow: 60_000 } };
}
