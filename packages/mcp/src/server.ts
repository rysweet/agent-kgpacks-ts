// Server factory.
//
// Assembles an `McpServer` with the ported identity (name + instructions) and the
// three knowledge-pack tools. Both the packs directory and the query seam are
// injectable; unset, they fall back to the production defaults
// (`<cwd>/data/packs` or `$KGPACKS_PACKS_DIR`, and the lazy retrieval runner).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { resolveDefaultPacksDir } from './config.js';
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from './constants.js';
import { defaultQueryRunner, type QueryRunner } from './query-runner.js';
import { registerTools } from './tools.js';

/** Construction options for {@link createServer}. */
export interface CreateServerOptions {
  /** Directory scanned for installed packs. Defaults to {@link resolveDefaultPacksDir}. */
  packsDir?: string;
  /** `query_knowledge_pack` execution seam. Defaults to {@link defaultQueryRunner}. */
  runQuery?: QueryRunner;
}

/** Creates a configured (but not yet connected) MCP server. */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const packsDir = options.packsDir ?? resolveDefaultPacksDir();
  const runQuery = options.runQuery ?? defaultQueryRunner();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerTools(server, { packsDir, runQuery });
  return server;
}
