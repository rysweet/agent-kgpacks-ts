import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database, type Connection } from '@kgpacks/db';
import { describe, expect, it } from 'vitest';

import { validateVectorIndexMembership } from '../src/incremental-update.js';

function connectionWithMembership(
  liveIds: string[],
  indexedIds: Array<string | null>,
  embedding: unknown = Array<number>(768).fill(1),
  visitedIds: string[] = [],
  physicalComplete = false,
): Connection {
  let internalCatalog = false;
  return {
    async run<T>(cypher: string, params?: Record<string, unknown>): Promise<T[]> {
      if (cypher.includes('enable_internal_catalog=true')) {
        internalCatalog = true;
        return [];
      }
      if (cypher.includes('enable_internal_catalog=false')) {
        internalCatalog = false;
        return [];
      }
      if (cypher.includes('SHOW_TABLES')) {
        expect(internalCatalog).toBe(true);
        return [
          { id: 1, name: 'Section', type: 'NODE' },
          { id: 2, name: 'Chunk', type: 'NODE' },
          { id: 10, name: '_1_embedding_idx_LOWER', type: 'REL' },
          { id: 11, name: '_2_chunk_embedding_idx_LOWER', type: 'REL' },
        ] as T[];
      }
      if (cypher.includes('count(DISTINCT source.id)')) {
        expect(internalCatalog).toBe(true);
        const members = physicalComplete
          ? liveIds.length
          : new Set(indexedIds.filter((id): id is string => typeof id === 'string')).size;
        return [{ count: liveIds.length <= 1 ? 0 : members }] as T[];
      }
      if (cypher.includes('QUERY_VECTOR_INDEX')) {
        return indexedIds.map((id) => ({ id })) as T[];
      }
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

  it('uses physical HNSW membership when approximate search cannot enumerate a valid index', async () => {
    const liveIds = Array.from(
      { length: 300 },
      (_, index) => `id-${index.toString().padStart(4, '0')}`,
    );

    await expect(
      validateVectorIndexMembership(
        connectionWithMembership(liveIds, liveIds.slice(0, 168), undefined, [], true),
        table,
        index,
      ),
    ).resolves.toBeUndefined();
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

  it.each([
    ['extra or stale', ['a', 'b', 'c', 'stale']],
    ['duplicate', ['a', 'b', 'b']],
    ['null', ['a', 'b', null]],
  ])(
    'does not hide malformed %s results behind physical cardinality',
    async (_label, indexedIds) => {
      await expect(
        validateVectorIndexMembership(
          connectionWithMembership(['a', 'b', 'c'], indexedIds, undefined, [], true),
          table,
          index,
        ),
      ).rejects.toThrow(new RegExp(`${index} membership does not match live ${table} rows`));
    },
  );

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

describe('vector-index membership with real HNSW approximation', () => {
  it('accepts a complete index even when one ANN query cannot enumerate it', async () => {
    const database = new Database();
    const connection = database.connect();
    try {
      await connection.loadExtension('vector');
      await connection.run(
        'CREATE NODE TABLE Section(id STRING PRIMARY KEY, embedding FLOAT[768])',
      );
      const embedding = Array<number>(768).fill(1);
      for (let offset = 0; offset < 300; offset++) {
        await connection.run('CREATE (:Section {id: $id, embedding: $embedding})', {
          id: `id-${offset.toString().padStart(4, '0')}`,
          embedding,
        });
      }
      await connection.run(
        "CALL CREATE_VECTOR_INDEX('Section', 'embedding_idx', 'embedding', metric := 'cosine')",
      );

      await expect(
        validateVectorIndexMembership(connection, 'Section', 'embedding_idx'),
      ).resolves.toBeUndefined();
    } finally {
      connection.close();
      database.close();
    }
  }, 30_000);

  it('rejects a physically incomplete lower HNSW graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kgpacks-incomplete-vector-index-'));
    const path = join(root, 'pack.db');
    let database = new Database(path);
    let connection = database.connect();
    try {
      await connection.loadExtension('vector');
      await connection.run(
        'CREATE NODE TABLE Section(id STRING PRIMARY KEY, embedding FLOAT[768])',
      );
      for (let offset = 0; offset < 3; offset++) {
        await connection.run('CREATE (:Section {id: $id, embedding: $embedding})', {
          id: `id-${offset}`,
          embedding: Array<number>(768).fill(offset + 1),
        });
      }
      await connection.run(
        "CALL CREATE_VECTOR_INDEX('Section', 'embedding_idx', 'embedding', metric := 'cosine')",
      );
      await connection.run('CALL enable_internal_catalog=true');
      const tables = await connection.run<{ id: number; name: string }>(
        'CALL SHOW_TABLES() RETURN id, name',
      );
      const tableId = tables.find(({ name }) => name === 'Section')?.id;
      expect(tableId).toBeTypeOf('number');
      await connection.run(
        `MATCH (source:Section)-[edge:_${tableId}_embedding_idx_LOWER]->() ` +
          "WHERE source.id = 'id-2' DELETE edge",
      );
      await connection.run('CALL enable_internal_catalog=false');
      connection.close();
      database.close();

      database = new Database(path, { readOnly: true });
      connection = database.connect();
      await connection.loadExtension('vector');
      await expect(
        validateVectorIndexMembership(connection, 'Section', 'embedding_idx'),
      ).rejects.toThrow(/membership does not match live Section rows/);
    } finally {
      connection.close();
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
