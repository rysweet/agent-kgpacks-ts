import { Database } from '@kgpacks/db';
import { describe, expect, it } from 'vitest';

import { buildVectorIndexes } from '../src/loader.js';
import { VECTOR_INDEX_DDL } from '../src/schema.js';

describe('vector index schema', () => {
  it('defines exactly the two required cosine HNSW indexes', () => {
    expect(VECTOR_INDEX_DDL).toEqual([
      "CALL CREATE_VECTOR_INDEX('Section', 'embedding_idx', 'embedding', metric := 'cosine', pu := 0.9999999999999999)",
      "CALL CREATE_VECTOR_INDEX('Chunk', 'chunk_embedding_idx', 'embedding', metric := 'cosine', pu := 0.9999999999999999)",
    ]);
  });

  it('uses a near-complete sampling value that remains below the database limit', () => {
    for (const ddl of VECTOR_INDEX_DDL) {
      const pu = Number(ddl.match(/\bpu := ([\d.]+)/)?.[1]);
      expect(pu).toBeGreaterThan(0.99);
      expect(pu).toBeLessThan(1);
    }
  });

  it('propagates database errors instead of partially succeeding without schema tables', async () => {
    const database = new Database();
    const connection = database.connect();
    try {
      await connection.loadExtension('vector');
      await expect(buildVectorIndexes(connection)).rejects.toThrow(/Section/i);
      const indexes = await connection.run('CALL SHOW_INDEXES() RETURN *');
      expect(indexes).toEqual([]);
    } finally {
      connection.close();
      database.close();
    }
  });
});
