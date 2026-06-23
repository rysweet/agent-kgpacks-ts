// @kgpacks/mcp — public entry point.
//
// TypeScript MCP server (stdio) replacing the upstream `mcp_server`. Exposes the
// three knowledge-pack tools — `list_packs`, `pack_info`, `query_knowledge_pack`
// — with byte-compatible names, argument schemas, and result shapes. See the
// package README and docs/PLAN.md "External Contracts" for the parity contract.

export { createServer } from './server.js';
export type { CreateServerOptions } from './server.js';

export { runStdioServer } from './stdio.js';

export { registerTools, listPacksText, packInfoText, queryKnowledgePackText } from './tools.js';
export type { ToolConfig } from './tools.js';

export { defaultQueryRunner } from './query-runner.js';
export type { QueryRunner, QueryRunnerInput, DefaultQueryResult } from './query-runner.js';

export { loadManifestLenient } from './manifest-io.js';
export type { RawManifest } from './manifest-io.js';

export { resolveDefaultPacksDir } from './config.js';

export {
  SERVER_NAME,
  SERVER_VERSION,
  SERVER_INSTRUCTIONS,
  PACKS_DIR_ENV,
  DB_FILENAME,
  URLS_FILENAME,
  DEFAULT_MAX_RESULTS,
  TOOL_LIST_PACKS,
  TOOL_PACK_INFO,
  TOOL_QUERY_KNOWLEDGE_PACK,
  packNotFoundMessage,
} from './constants.js';
