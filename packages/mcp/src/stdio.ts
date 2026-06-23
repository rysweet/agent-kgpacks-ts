// stdio transport entry point.
//
// Connects a configured server to the MCP stdio transport — the same transport
// the upstream `mcp.run(transport="stdio")` uses, so the documented VS Code /
// Claude Desktop launch configs work unchanged against this server.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer, type CreateServerOptions } from './server.js';

/** Creates the server and serves it over stdio until the transport closes. */
export async function runStdioServer(options: CreateServerOptions = {}): Promise<void> {
  const server = createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
