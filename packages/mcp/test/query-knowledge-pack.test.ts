// packages/mcp/test/query-knowledge-pack.test.ts
//
// Tests the `query_knowledge_pack` tool body against its injectable runner seam:
// success serializes the runner result (2-space indent), a missing database and
// runner failures return the Python compact error payloads, and the pack-safety
// gate still applies.

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { packNotFoundMessage } from '../src/constants.js';
import { queryKnowledgePackText, type ToolConfig } from '../src/tools.js';
import type { QueryRunner } from '../src/query-runner.js';
import { makeMockPacks, type MockPacks } from './helpers/mock-packs.js';

let packs: MockPacks;

function configWith(runQuery: QueryRunner): ToolConfig {
  return { packsDir: packs.packsDir, runQuery };
}

beforeEach(() => {
  packs = makeMockPacks();
});

afterEach(() => {
  packs.cleanup();
});

describe('query_knowledge_pack', () => {
  it('serializes the runner result and passes through the resolved inputs', async () => {
    const fixture = {
      answer: 'Paris is the capital of France.',
      sources: ['France', 'Paris'],
      entities: [{ name: 'Paris', type: 'city' }],
      facts: ['Paris is in France.'],
      cypher_query: 'MATCH (n) RETURN n',
    };
    const runQuery = vi.fn<QueryRunner>().mockResolvedValue(fixture);

    const out = await queryKnowledgePackText(
      configWith(runQuery),
      'alpha-pack',
      'What is the capital of France?',
      5,
    );

    expect(out).toBe(JSON.stringify(fixture, null, 2));
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery).toHaveBeenCalledWith({
      packName: 'alpha-pack',
      dbPath: join(packs.packsDir, 'alpha-pack', 'pack.db'),
      question: 'What is the capital of France?',
      maxResults: 5,
    });
  });

  it('returns the compact "Database not found" payload when pack.db is absent', async () => {
    const runQuery = vi.fn<QueryRunner>();
    const dbPath = join(packs.packsDir, 'beta-pack', 'pack.db');

    const out = await queryKnowledgePackText(configWith(runQuery), 'beta-pack', 'hi', 5);

    expect(out).toBe(`{"error": "Database not found at ${dbPath}"}`);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('returns the compact error+pack payload when the runner throws', async () => {
    const runQuery = vi.fn<QueryRunner>().mockRejectedValue(new Error('boom'));

    const out = await queryKnowledgePackText(configWith(runQuery), 'alpha-pack', 'hi', 5);

    expect(out).toBe('{"error": "boom", "pack": "alpha-pack"}');
  });

  it('throws the "not found" message for unknown and traversal pack names', async () => {
    const runQuery = vi.fn<QueryRunner>();
    await expect(queryKnowledgePackText(configWith(runQuery), 'nope', 'hi', 5)).rejects.toThrow(
      packNotFoundMessage('nope'),
    );
    await expect(queryKnowledgePackText(configWith(runQuery), '../etc', 'hi', 5)).rejects.toThrow(
      packNotFoundMessage('../etc'),
    );
    expect(runQuery).not.toHaveBeenCalled();
  });
});
