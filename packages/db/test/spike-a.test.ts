// packages/db/test/spike-a.test.ts
//
// Spike A (vector slice) — the marquee behavioral test for Phase 0.
//
// Proves the vector path drives end-to-end from the @kgpacks/db wrapper:
//   open in-memory LadybugDB -> INSTALL/LOAD EXTENSION VECTOR
//   -> FLOAT[N] node table -> CREATE_VECTOR_INDEX (cosine HNSW)
//   -> QUERY_VECTOR_INDEX -> assert correct cosine-ranked nearest neighbors.
//
// Cosine math for query q = [1, 0.05, 0, 0]:
//   doc1 [1, 0, 0, 0]   cos ~ 0.99875  (closest)
//   doc2 [0.9, 0.1,0,0] cos ~ 0.99803
//   doc3 [0, 1, 0, 0]   cos ~ 0.04994
//   doc4 [0, 0, 0, 1]   cos = 0        (farthest)
// => cosine-ranked order is [1, 2, 3, 4]; distance (1 - cos) is non-decreasing.
// The dataset is tiny, so HNSW search is effectively exact and the ordering is
// deterministic and safe to assert on.
//
// NOTE: loadExtension('vector') may fetch the VECTOR extension over HTTPS the
// first time; the test job needs outbound network access (fail-closed by design).
//
// TDD: FAILS today (no packages/db/src/index.ts, exact CALL signatures
// unverified). PASSES once the wrapper + @ladybugdb/core@0.17.1 are wired and the
// real vector procedure signatures are confirmed.

import { afterAll, describe, expect, it } from 'vitest';

import { Database } from '../src/index.js';

describe('Spike A — LadybugDB vector index (cosine)', () => {
  const db = new Database(); // in-memory
  const conn = db.connect();

  afterAll(() => {
    conn.close();
    db.close();
  });

  it('returns cosine-ranked nearest neighbors via QUERY_VECTOR_INDEX', async () => {
    // 1. Load the VECTOR extension (INSTALL + LOAD EXTENSION sequence).
    await conn.loadExtension('vector');

    // 2. Node table with a 4-dimensional FLOAT embedding column.
    await conn.run('CREATE NODE TABLE Doc(id INT64, embedding FLOAT[4], PRIMARY KEY(id))');

    // 3. Seed documents with known vectors.
    const docs = [
      { id: 1, vec: [1.0, 0.0, 0.0, 0.0] }, // nearest to the query
      { id: 2, vec: [0.9, 0.1, 0.0, 0.0] }, // second nearest
      { id: 3, vec: [0.0, 1.0, 0.0, 0.0] }, // far (orthogonal axis)
      { id: 4, vec: [0.0, 0.0, 0.0, 1.0] }, // farthest (orthogonal to query)
    ];
    for (const d of docs) {
      await conn.run('CREATE (:Doc {id: $id, embedding: $vec})', { id: d.id, vec: d.vec });
    }

    // 4. Build the cosine HNSW index.
    await conn.run(
      `CALL CREATE_VECTOR_INDEX('Doc', 'doc_vec_idx', 'embedding', metric := 'cosine')`,
    );

    // 5. Query for the 3 nearest neighbors of a vector near doc 1/2.
    const query = [1.0, 0.05, 0.0, 0.0];
    const rows = await conn.run<{ id: number | bigint; distance: number }>(
      `CALL QUERY_VECTOR_INDEX('Doc', 'doc_vec_idx', $query, $k)
       RETURN node.id AS id, distance AS distance
       ORDER BY distance`,
      { query, k: 3 },
    );

    // 6. Assert the exact cosine-ranked nearest-neighbor order.
    const rankedIds = rows.map((r) => Number(r.id));
    expect(rankedIds).toEqual([1, 2, 3]);
    expect(rankedIds[0]).toBe(1); // strictly closest
    expect(rankedIds).not.toContain(4); // farthest excluded from top-3

    // 7. Distances are non-decreasing (nearest first).
    const distances = rows.map((r) => Number(r.distance));
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
    }
  });
});
