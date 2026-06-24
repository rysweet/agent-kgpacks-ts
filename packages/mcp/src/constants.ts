// @kgpacks/mcp — server identity, tool metadata, and runtime defaults.
//
// These constants mirror the upstream `mcp_server` contract (server name,
// instructions, tool names, and the tool descriptions ported from the upstream
// docstrings). They are the source of truth the schema snapshot locks, so the
// VS Code / Claude Desktop tool surface stays a drop-in for the upstream server.

/** MCP server name advertised to clients (matches the upstream `FastMCP(name=...)`). */
export const SERVER_NAME = 'agent-kgpacks';

/** Server version reported in the MCP `initialize` handshake (implementation info). */
export const SERVER_VERSION = '0.0.0';

/** Server `instructions`, ported verbatim from the upstream `FastMCP(instructions=...)`. */
export const SERVER_INSTRUCTIONS =
  'Knowledge-pack query server. Use list_packs to discover available packs, ' +
  'pack_info to inspect a specific pack, and query_knowledge_pack to ask ' +
  "questions against a pack's knowledge graph.";

/** Environment variable overriding the packs directory. */
export const PACKS_DIR_ENV = 'KGPACKS_PACKS_DIR';

/** Per-pack LadybugDB database filename (probed by `pack_info` / `query_knowledge_pack`). */
export const DB_FILENAME = 'pack.db';

/** Per-pack source-URL list filename (probed by `pack_info`). */
export const URLS_FILENAME = 'urls.txt';

/** Default `max_results` for `query_knowledge_pack` (matches the upstream default). */
export const DEFAULT_MAX_RESULTS = 5;

/** Upper bound for `max_results` (mirrors the HTTP backend's 1..50 cap on `k`). */
export const MAX_MAX_RESULTS = 50;

// --- Tool names (BYTE-COMPATIBLE with the upstream server; configs depend on these) ---

export const TOOL_LIST_PACKS = 'list_packs';
export const TOOL_PACK_INFO = 'pack_info';
export const TOOL_QUERY_KNOWLEDGE_PACK = 'query_knowledge_pack';

// --- Tool descriptions (ported from the upstream docstrings) ---

export const LIST_PACKS_DESCRIPTION = `List all available knowledge packs with article counts.

Returns a JSON array of objects with name, description, and article_count
for every pack found under data/packs/.`;

export const PACK_INFO_DESCRIPTION = `Return full manifest details for a specific knowledge pack.

Args:
    pack_name: Directory name of the pack (e.g. 'rust-expert').`;

export const QUERY_KNOWLEDGE_PACK_DESCRIPTION = `Query a knowledge pack's graph and return an answer with sources.

Performs vector + graph search over the pack's LadybugDB database and
synthesizes a natural-language answer.

Args:
    pack_name: Directory name of the pack (e.g. 'rust-expert').
    question: Natural language question to answer.
    max_results: Maximum number of graph results to retrieve (1-1000).`;

/**
 * Error message for an unknown / invalid pack name. Matches the upstream
 * `_get_pack_dir` `ValueError` text byte-for-byte so MCP clients see the same
 * error content whether they talk to the upstream or the TypeScript server.
 */
export function packNotFoundMessage(packName: string): string {
  return `Pack '${packName}' not found. Use list_packs() to see available packs.`;
}
