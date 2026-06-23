// Streaming bulk loader round-trip + parity: createPackWriter must produce a pack
// @kgpacks/query reads back exactly like loadPack — same nodes, edges, vector
// indexes — while loading across multiple batches (cross-batch entity dedup;
// deferred ENTITY_RELATION / LINKS_TO resolved in finalize()).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Database, type Connection } from '@kgpacks/db';

import { createPackWriter, type PackWriterStats } from '../src/streaming-loader.js';
import type { LoadableArticle } from '../src/loader.js';
import { makeArticle, oneHot } from './helpers.js';

function loadable(
  title: string,
  content: string,
  emb: number[],
  extraction: LoadableArticle['extraction'],
): LoadableArticle {
  const article = makeArticle(title, [content]);
  return {
    article,
    sectionEmbeddings: [emb],
    chunks: [{ id: `${title}#0#0`, content, articleTitle: title, sectionIndex: 0, chunkIndex: 0 }],
    chunkEmbeddings: [emb],
    extraction,
  };
}

describe('createPackWriter — streaming round-trip', () => {
  const db = new Database();
  let conn: Connection;
  let stats: PackWriterStats;

  beforeAll(async () => {
    conn = db.connect();
    const writer = await createPackWriter(conn, { insertChunkSize: 2 });

    // Batch 1: Alpha (Plant -uses-> Photosynthesis); shares the "Plant" entity with batch 2.
    await writer.addBatch([
      loadable('Alpha', 'Alpha lead about photosynthesis and light.', oneHot(0), {
        entities: [
          { name: 'Photosynthesis', type: 'concept' },
          { name: 'Plant', type: 'concept' },
        ],
        relationships: [{ source: 'Plant', target: 'Photosynthesis', relation: 'uses' }],
        keyFacts: [],
      }),
    ]);

    // Batch 2: Beta — re-declares "Plant" (must dedupe) + a cross-batch relationship
    // whose endpoints live in different batches (Basketball here, Plant in batch 1).
    await writer.addBatch([
      loadable('Beta', 'Beta lead about basketball and sport.', oneHot(100), {
        entities: [
          { name: 'Basketball', type: 'concept' },
          { name: 'Plant', type: 'concept' },
        ],
        relationships: [{ source: 'Basketball', target: 'Plant', relation: 'unrelated_to' }],
        keyFacts: [],
      }),
    ]);

    // Link across batches (Alpha -> Beta), resolved in finalize().
    stats = await writer.finalize([{ from: 'Alpha', to: 'Beta', linkType: 'wiki' }]);
  });

  afterAll(() => {
    conn.close();
    db.close();
  });

  it('reports counts with cross-batch entity dedup (Plant counted once)', () => {
    expect(stats).toMatchObject({
      articles: 2,
      sections: 2,
      chunks: 2,
      entities: 3, // Photosynthesis, Plant, Basketball — Plant deduped across batches
      relationships: 2, // Plant->Photosynthesis and Basketball->Plant (cross-batch)
      links: 1,
    });
  });

  it('serves Section.embedding_idx via QUERY_VECTOR_INDEX (the read contract)', async () => {
    const rows = await conn.run<{ id: string; content: unknown; distance: number }>(
      `CALL QUERY_VECTOR_INDEX('Section', 'embedding_idx', $emb, $k)
       RETURN node.id AS id, node.content AS content, distance AS distance ORDER BY distance`,
      { emb: oneHot(0), k: 2 },
    );
    expect(rows[0].id).toBe('Alpha#0');
    expect(String(rows[0].content)).toContain('photosynthesis');
  });

  it('serves the independent Chunk.chunk_embedding_idx', async () => {
    const rows = await conn.run<{ id: string }>(
      `CALL QUERY_VECTOR_INDEX('Chunk', 'chunk_embedding_idx', $emb, $k)
       RETURN node.id AS id, distance AS distance ORDER BY distance`,
      { emb: oneHot(100), k: 1 },
    );
    expect(rows[0].id).toBe('Beta#0#0');
  });

  it('resolves the cross-batch Section→Section LINKS_TO in finalize()', async () => {
    const rows = await conn.run<{ id: string }>(
      `MATCH (seed:Section {id: $id})-[:LINKS_TO]->(n:Section) RETURN n.id AS id`,
      { id: 'Alpha#0' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('Beta#0');
  });

  it('materializes a single Plant entity and the cross-batch ENTITY_RELATION', async () => {
    const plants = await conn.run<{ n: number | bigint }>(
      `MATCH (e:Entity {entity_id: 'Plant'}) RETURN count(e) AS n`,
    );
    expect(Number(plants[0].n)).toBe(1);

    const rels = await conn.run<{ rel: string }>(
      `MATCH (:Entity {entity_id: 'Basketball'})-[r:ENTITY_RELATION]->(:Entity {entity_id: 'Plant'})
       RETURN r.relation AS rel`,
    );
    expect(rels).toHaveLength(1);
    expect(rels[0].rel).toBe('unrelated_to');
  });
});
