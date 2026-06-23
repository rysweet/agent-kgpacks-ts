// packages/query/test/hybrid.test.ts
//
// Verifies the three-signal hybrid scoring formula (vector + graph + keyword)
// ported from Python `hybrid_retrieve`. To assert the exact arithmetic we drive
// retrieval with a DETERMINISTIC injected embedder and explicit one-hot section
// vectors, so cosine similarities are exactly known and the only variability is
// the formula itself. No model download is needed for this suite.
//
// Fixture (FLOAT[768] one-hot embeddings, LINKS_TO edge 1 -> 2):
//   Section 1 "Alpha Physics"   e0
//   Section 2 "Beta Chemistry"  e1   (LINKS_TO neighbor of section 1)
//   Section 3 "Gamma Biology"   e2
//   Section 4 "Delta History"   e3
//
// Query "Alpha quantum theory" with the injected embedder returning e0:
//   vector:  section 1 similarity 1 -> 0.5 * 1   = 0.50
//   keyword: "Alpha" CONTAINS title 1            += 0.2 * 0.7 = 0.14
//   graph:   seed 1 -> neighbor 2                += 0.3 * 0.5 = 0.15
//   => scores: {1: 0.64, 2: 0.15, 3: 0, 4: 0}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Database, type Connection } from '@kgpacks/db';

import { createRetriever } from '../src/index.js';
import type { Embedder } from '../src/index.js';

const DIM = 768;

function oneHot(index: number): number[] {
  const vec = new Array<number>(DIM).fill(0);
  vec[index] = 1;
  return vec;
}

// Deterministic embedder: every query maps to e0 (aligned with section 1).
const fixedEmbedder: Embedder = {
  async generateQuery(queries: string[]): Promise<Float32Array[]> {
    return queries.map(() => Float32Array.from(oneHot(0)));
  },
};

interface Section {
  id: number;
  title: string;
  content: string;
  dim: number;
}

const SECTIONS: readonly Section[] = [
  { id: 1, title: 'Alpha Physics', content: 'Alpha content', dim: 0 },
  { id: 2, title: 'Beta Chemistry', content: 'Beta content', dim: 1 },
  { id: 3, title: 'Gamma Biology', content: 'Gamma content', dim: 2 },
  { id: 4, title: 'Delta History', content: 'Delta content', dim: 3 },
];

describe('hybridRetrieve — weighted vector + graph + keyword signals', () => {
  const db = new Database();
  const conn: Connection = db.connect();

  beforeAll(async () => {
    await conn.loadExtension('vector');
    await conn.run(
      'CREATE NODE TABLE Section(id INT64, title STRING, content STRING, ' +
        'embedding FLOAT[768], PRIMARY KEY(id))',
    );
    await conn.run('CREATE REL TABLE LINKS_TO(FROM Section TO Section)');

    for (const s of SECTIONS) {
      await conn.run(
        'CREATE (:Section {id: $id, title: $title, content: $content, embedding: $emb})',
        { id: s.id, title: s.title, content: s.content, emb: oneHot(s.dim) },
      );
    }

    // Graph proximity: section 1 links to section 2.
    await conn.run('MATCH (a:Section {id: 1}), (b:Section {id: 2}) CREATE (a)-[:LINKS_TO]->(b)');

    await conn.run(
      `CALL CREATE_VECTOR_INDEX('Section', 'embedding_idx', 'embedding', metric := 'cosine')`,
    );
  });

  afterAll(() => {
    conn.close();
    db.close();
  });

  it('combines all three signals and ranks by the weighted sum', async () => {
    const retriever = createRetriever(conn, { embedder: fixedEmbedder });

    const results = await retriever.retrieve('Alpha quantum theory', {
      mode: 'hybrid',
      k: 4,
    });

    const byId = new Map(results.map((r) => [r.id, r]));

    // Section 1: vector 0.5 + keyword 0.14 = 0.64 (top).
    expect(results[0].id).toBe('1');
    expect(results[0].content).toBe('Alpha content');
    expect(results[0].score).toBeCloseTo(0.64, 4);

    // Section 2: graph-only 0.15 — ranked second on the strength of the
    // LINKS_TO signal alone (its vector similarity is 0).
    expect(results[1].id).toBe('2');
    expect(byId.get('2')?.score).toBeCloseTo(0.15, 4);

    // The graph signal lifts section 2 above the zero-scored sections 3 and 4.
    const rank = (id: string): number => results.findIndex((r) => r.id === id);
    expect(rank('2')).toBeLessThan(rank('3'));
    expect(rank('2')).toBeLessThan(rank('4'));
  });

  it('drops the keyword signal when its weight is zero (parity)', async () => {
    const retriever = createRetriever(conn, { embedder: fixedEmbedder });

    const results = await retriever.retrieve('Alpha quantum theory', {
      mode: 'hybrid',
      k: 4,
      weights: { vector: 0.5, graph: 0.3, keyword: 0 },
    });

    // Without the +0.14 keyword boost, section 1 is purely its vector signal.
    expect(results[0].id).toBe('1');
    expect(results[0].score).toBeCloseTo(0.5, 4);
    expect(results[1].id).toBe('2');
  });

  it('still answers vector mode against the same fixture', async () => {
    const retriever = createRetriever(conn, { embedder: fixedEmbedder });
    const results = await retriever.retrieve('anything', { k: 2 });
    expect(results[0].id).toBe('1');
    expect(results[0].score).toBeCloseTo(1, 4);
  });
});
