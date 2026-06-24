// @kgpacks/backend — public entry point.
//
// The single seam is `buildServer(options)`; `loadConfig` is exposed for callers
// that want to inspect resolved settings. When this module is executed directly
// (the package bin, `node dist/index.js`), it reads configuration from the
// environment, opens the database, optionally starts a Copilot agent, and listens.

import { CopilotAgent } from '@kgpacks/agent';
import { Database } from '@kgpacks/db';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { buildServer } from './server.js';

export { buildServer, CopilotAgent } from './server.js';
export type { BuildServerOptions } from './server.js';
export { loadConfig, mergeConfig } from './config.js';
export type { Settings, RateLimits, CacheTtls, SettingsOverride } from './config.js';
export { ConnectionManager } from './connection.js';
export { ApiError, errorEnvelope, nowIso } from './errors.js';
export type { ErrorCode, ErrorEnvelope } from './errors.js';
export type { ChatAgent } from './services/chat.js';
export type {
  ArticleDetail,
  ArticleSection,
  AutocompleteResponse,
  AutocompleteResult,
  CategoryInfo,
  CategoryListResponse,
  ChatResponse,
  GraphEdge,
  GraphNode,
  GraphResponse,
  HealthResponse,
  SearchResponse,
  SearchResult,
  StatsResponse,
} from './types.js';

/**
 * True when at least one BYOK credential is present and NON-EMPTY. Empty strings
 * count as unset (matching the project convention and the docker-compose deploy,
 * which forwards each key as `${VAR:-}` = `''` when absent). Using `??`/first-key
 * precedence here is wrong: `'' ?? next` short-circuits on an empty earlier key.
 */
export function hasByokCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return [env.COPILOT_API_KEY, env.OPENAI_API_KEY, env.ANTHROPIC_API_KEY].some(
    (key) => typeof key === 'string' && key.trim() !== '',
  );
}

/** Boots a server from environment configuration and starts listening. */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.databasePath === '') {
    throw new Error('WIKIGR_DATABASE_PATH is required to start the server.');
  }
  const database = new Database(config.databasePath);

  // Start a Copilot agent only when BYOK credentials are present; otherwise the
  // chat endpoints report 503 while every other endpoint serves normally. The
  // synthesis timeout is operator-configurable (WIKIGR_STREAM_TIMEOUT_S) instead
  // of relying on the SDK's built-in default, so a wedged upstream can't hang a
  // /chat request indefinitely.
  let agent: CopilotAgent | undefined;
  if (hasByokCredentials()) {
    agent = new CopilotAgent({ timeoutMs: config.streamTimeoutMs });
    await agent.start();
  }

  const app = await buildServer({ database, agent, logger: true });
  await app.listen({ host: config.host, port: config.port });
}

// Run only when invoked directly as the process entry (not when imported).
if (argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
