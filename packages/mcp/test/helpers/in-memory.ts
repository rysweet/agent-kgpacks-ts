// packages/mcp/test/helpers/in-memory.ts
//
// Connects an `McpServer` to an in-process MCP `Client` over a linked in-memory
// transport pair. This exercises the real protocol round-trip — `tools/list` and
// `tools/call` go through the SDK's schema generation and result framing — so the
// tests assert exactly what a VS Code / Claude Desktop client would receive.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** A connected client plus a teardown that closes both ends. */
export interface ConnectedClient {
  client: Client;
  close: () => Promise<void>;
}

/** Links `server` to a fresh in-memory client and completes the handshake. */
export async function connectInMemory(server: McpServer): Promise<ConnectedClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'kgpacks-mcp-test-client', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
