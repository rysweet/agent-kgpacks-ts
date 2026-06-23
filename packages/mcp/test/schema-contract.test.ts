// packages/mcp/test/schema-contract.test.ts
//
// Locks the EXTERNAL CONTRACT consumed by VS Code / Claude Desktop configs: the
// server identity (name + instructions) and the three tools' on-the-wire schemas
// (names, argument names/types, required vs optional, defaults). The full
// `tools/list` payload is snapshotted so any drift fails CI; targeted assertions
// document the load-bearing fields explicitly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SERVER_INSTRUCTIONS, SERVER_NAME } from '../src/constants.js';
import { createServer } from '../src/server.js';
import type { QueryRunner } from '../src/query-runner.js';
import { connectInMemory, type ConnectedClient } from './helpers/in-memory.js';
import { makeMockPacks, type MockPacks } from './helpers/mock-packs.js';

let packs: MockPacks;
let connected: ConnectedClient;

beforeEach(async () => {
  packs = makeMockPacks();
  const runQuery = vi.fn<QueryRunner>().mockResolvedValue({});
  const server = createServer({ packsDir: packs.packsDir, runQuery });
  connected = await connectInMemory(server);
});

afterEach(async () => {
  await connected.close();
  packs.cleanup();
});

describe('MCP server identity', () => {
  it('advertises the ported name and instructions', () => {
    expect(connected.client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(connected.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });
});

describe('tools/list schema contract', () => {
  it('matches the locked snapshot', async () => {
    const { tools } = await connected.client.listTools();
    expect(tools).toMatchSnapshot();
  });

  it('exposes exactly the three byte-compatible tool names', async () => {
    const { tools } = await connected.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_packs',
      'pack_info',
      'query_knowledge_pack',
    ]);
  });

  it('declares pack_info(pack_name: string) with pack_name required', async () => {
    const { tools } = await connected.client.listTools();
    const tool = tools.find((t) => t.name === 'pack_info');
    expect(tool?.inputSchema.properties).toMatchObject({ pack_name: { type: 'string' } });
    expect(tool?.inputSchema.required).toEqual(['pack_name']);
  });

  it('declares query_knowledge_pack args, types, defaults, and required set', async () => {
    const { tools } = await connected.client.listTools();
    const tool = tools.find((t) => t.name === 'query_knowledge_pack');
    expect(tool?.inputSchema.properties).toMatchObject({
      pack_name: { type: 'string' },
      question: { type: 'string' },
      max_results: { type: 'integer', default: 5 },
    });
    // max_results has a default, so it is optional.
    expect(tool?.inputSchema.required).toEqual(['pack_name', 'question']);
  });

  it('declares list_packs with no arguments', async () => {
    const { tools } = await connected.client.listTools();
    const tool = tools.find((t) => t.name === 'list_packs');
    expect(tool?.inputSchema.properties ?? {}).toEqual({});
    expect(tool?.inputSchema.required ?? []).toEqual([]);
  });
});
