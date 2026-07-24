import type { Connection } from '@kgpacks/db';
import { describe, expect, it } from 'vitest';

import { validateVectorIndexMembership } from '../src/incremental-update.js';

function connectionWithMembership(
  liveIds: string[],
  indexedIds: Array<string | null>,
  embedding: unknown = Array<number>(768).fill(1),
  visitedIds: string[] = [],
): Connection {
  return {
    async run<T>(cypher: string, params?: Record<string, unknown>): Promise<T[]> {
      if (cypher.includes(`MATCH (node:`)) {
        const afterId = String(params?.afterId ?? '');
        const limit = Number(/\bLIMIT (\d+)$/.exec(cypher)?.[1]);
        if (!Number.isInteger(limit) || limit <= 0)
          throw new Error(`invalid scan query: ${cypher}`);
        const rows = liveIds
          .filter((id) => id > afterId)
          .slice(0, limit)
          .map((id) => ({ id, embedding }));
        visitedIds.push(...rows.map(({ id }) => id));
        return rows as T[];
      }
      if (cypher.includes('QUERY_VECTOR_INDEX')) {
        return indexedIds.map((id) => ({ id })) as T[];
      }
      throw new Error(`unexpected query: ${cypher}`);
    },
  } as Connection;
}

describe.each([
  ['Section', 'embedding_idx'],
  ['Chunk', 'chunk_embedding_idx'],
] as const)('%s vector-index membership', (table, index) => {
  it('accepts the exact live-row multiset', async () => {
    await expect(
      validateVectorIndexMembership(
        connectionWithMembership(['a', 'b', 'c'], ['c', 'a', 'b']),
        table,
        index,
      ),
    ).resolves.toBeUndefined();
  });

  it('validates every live row across multiple scan pages', async () => {
    const liveIds = Array.from(
      { length: 1100 },
      (_, index) => `id-${index.toString().padStart(4, '0')}`,
    );
    const visitedIds: string[] = [];

    await expect(
      validateVectorIndexMembership(
        connectionWithMembership(liveIds, liveIds, undefined, visitedIds),
        table,
        index,
      ),
    ).resolves.toBeUndefined();
    expect(visitedIds).toEqual(liveIds);
  });

  it.each([
    ['incomplete', ['a', 'b']],
    ['extra or stale', ['a', 'b', 'c', 'stale']],
    ['duplicate', ['a', 'b', 'b']],
    ['null', ['a', 'b', null]],
  ])('rejects %s index membership', async (_label, indexedIds) => {
    await expect(
      validateVectorIndexMembership(
        connectionWithMembership(['a', 'b', 'c'], indexedIds),
        table,
        index,
      ),
    ).rejects.toThrow(new RegExp(`${index} membership does not match live ${table} rows`));
  });

  it('requires an empty index for an empty live table', async () => {
    await expect(
      validateVectorIndexMembership(connectionWithMembership([], []), table, index),
    ).resolves.toBeUndefined();
    await expect(
      validateVectorIndexMembership(connectionWithMembership([], ['stale']), table, index),
    ).rejects.toThrow(/membership does not match live/i);
  });

  it.each([
    ['wrong dimensions', [1, 2, 3]],
    ['non-finite values', [...Array<number>(767).fill(1), Number.NaN]],
  ])('rejects live embeddings with %s', async (_label, embedding) => {
    await expect(
      validateVectorIndexMembership(
        connectionWithMembership(['a'], ['a'], embedding),
        table,
        index,
      ),
    ).rejects.toThrow(/membership does not match live/i);
  });
});
