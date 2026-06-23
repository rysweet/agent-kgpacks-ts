// packages/mcp/test/server.e2e.test.ts
//
// End-to-end tool calls through the MCP SDK: verifies that `createServer` wires
// each tool's result content correctly, that `max_results` defaults to 5 over the
// wire, and that a thrown "not found" becomes an `isError` result — exactly what
// an MCP client observes.

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { packNotFoundMessage } from '../src/constants.js';
import { createServer } from '../src/server.js';
import { listPacksText, packInfoText } from '../src/tools.js';
import type { QueryRunner } from '../src/query-runner.js';
import { connectInMemory, type ConnectedClient } from './helpers/in-memory.js';
import { makeMockPacks, type MockPacks } from './helpers/mock-packs.js';

interface TextContent {
  type: string;
  text: string;
}

function firstText(result: { content: unknown }): string {
  const content = result.content as TextContent[];
  return content[0].text;
}

let packs: MockPacks;
let runQuery: ReturnType<typeof vi.fn<QueryRunner>>;
let connected: ConnectedClient;

beforeEach(async () => {
  packs = makeMockPacks();
  runQuery = vi.fn<QueryRunner>().mockResolvedValue({ answer: 'ok', sources: [] });
  const server = createServer({ packsDir: packs.packsDir, runQuery });
  connected = await connectInMemory(server);
});

afterEach(async () => {
  await connected.close();
  packs.cleanup();
});

describe('server end-to-end', () => {
  it('list_packs returns the same text as the pure tool function', async () => {
    const result = await connected.client.callTool({ name: 'list_packs', arguments: {} });
    expect(firstText(result)).toBe(listPacksText(packs.packsDir));
  });

  it('pack_info returns the manifest + computed flags', async () => {
    const result = await connected.client.callTool({
      name: 'pack_info',
      arguments: { pack_name: 'alpha-pack' },
    });
    expect(firstText(result)).toBe(packInfoText(packs.packsDir, 'alpha-pack'));
  });

  it('pack_info on an unknown pack yields an isError result with the ported message', async () => {
    const result = await connected.client.callTool({
      name: 'pack_info',
      arguments: { pack_name: 'missing' },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe(packNotFoundMessage('missing'));
  });

  it('query_knowledge_pack defaults max_results to 5 over the wire', async () => {
    const result = await connected.client.callTool({
      name: 'query_knowledge_pack',
      arguments: { pack_name: 'alpha-pack', question: 'q' },
    });
    expect(firstText(result)).toBe(JSON.stringify({ answer: 'ok', sources: [] }, null, 2));
    expect(runQuery).toHaveBeenCalledWith({
      packName: 'alpha-pack',
      dbPath: join(packs.packsDir, 'alpha-pack', 'pack.db'),
      question: 'q',
      maxResults: 5,
    });
  });

  it('query_knowledge_pack forwards an explicit max_results', async () => {
    await connected.client.callTool({
      name: 'query_knowledge_pack',
      arguments: { pack_name: 'alpha-pack', question: 'q', max_results: 25 },
    });
    expect(runQuery.mock.calls[0]?.[0].maxResults).toBe(25);
  });
});
