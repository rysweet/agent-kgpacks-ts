// packages/backend/test/helpers.ts
//
// Shared setup for the offline route suites: build a backend server wired to the
// in-memory fixture and the offline stubs. Rate limiting is disabled by default
// (the rate-limit suite opts in), and `env: {}` isolates config from the ambient
// environment so settings are deterministic.

import type { FastifyInstance } from 'fastify';

import type { SettingsOverride } from '../src/index.js';
import { buildServer } from '../src/index.js';
import type { Database } from '@kgpacks/db';
import { buildFixtureDatabase } from './fixture.js';
import { FakeAgent, FakeEmbedder, type FakeAgentOptions } from './stubs.js';

export interface TestServerOptions {
  /** Provide an agent; pass `null` to omit it (chat → 503). Default: a FakeAgent. */
  agent?: FakeAgent | null;
  agentOptions?: FakeAgentOptions;
  embedder?: FakeEmbedder;
  rateLimit?: boolean;
  config?: SettingsOverride;
  env?: Record<string, string | undefined>;
}

export interface TestServer {
  app: FastifyInstance;
  database: Database;
  agent: FakeAgent | undefined;
  embedder: FakeEmbedder;
  close: () => Promise<void>;
}

/** Builds a server over a fresh fixture database; remember to call `close()`. */
export async function makeTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const database = await buildFixtureDatabase();
  const embedder = options.embedder ?? new FakeEmbedder();
  const agent =
    options.agent === null ? undefined : (options.agent ?? new FakeAgent(options.agentOptions));

  const app = await buildServer({
    database,
    agent,
    embedder,
    rateLimit: options.rateLimit ?? false,
    config: options.config,
    env: options.env ?? {},
  });

  return {
    app,
    database,
    agent,
    embedder,
    close: async () => {
      await app.close();
      database.close();
    },
  };
}
