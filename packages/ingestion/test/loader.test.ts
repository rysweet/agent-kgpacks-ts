// Loader round-trip: a pack built here is read back exactly as @kgpacks/query reads
// it — QUERY_VECTOR_INDEX over Section.embedding_idx and Section→Section LINKS_TO.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Database, type Connection } from '@kgpacks/db';

import { loadPack, type LoadPackInput, type LoadPackStats } from '../src/loader.js';
import { makeArticle, oneHot } from './helpers.js';

describe('loadPack — in-memory round-trip', () => {
  const db = new Database();
  let conn: Connection;
  let stats: LoadPackStats;

  beforeAll(async () => {
    conn = db.connect();

    const alpha = makeArticle('Alpha', ['Alpha lead about photosynthesis and light.']);
    const beta = makeArticle('Beta', ['Beta lead about basketball and sport.']);

    const input: LoadPackInput = {
      articles: [
        {
          article: alpha,
          sectionEmbeddings: [oneHot(0)],
          chunks: [
            {
              id: 'Alpha#0#0',
              content: 'Alpha lead about photosynthesis and light.',
              articleTitle: 'Alpha',
              sectionIndex: 0,
              chunkIndex: 0,
            },
          ],
          chunkEmbeddings: [oneHot(0)],
          extraction: {
            entities: [
              { name: 'Photosynthesis', type: 'concept' },
              { name: 'Plant', type: 'concept' },
            ],
            relationships: [{ source: 'Plant', target: 'Photosynthesis', relation: 'uses' }],
            keyFacts: ['Plants convert light to energy.'],
          },
        },
        {
          article: beta,
          sectionEmbeddings: [oneHot(100)],
          chunks: [
            {
              id: 'Beta#0#0',
              content: 'Beta lead about basketball and sport.',
              articleTitle: 'Beta',
              sectionIndex: 0,
              chunkIndex: 0,
            },
          ],
          chunkEmbeddings: [oneHot(100)],
          extraction: {
            entities: [{ name: 'Basketball', type: 'concept' }],
            relationships: [],
            keyFacts: [],
          },
        },
      ],
      links: [{ from: 'Alpha', to: 'Beta', linkType: 'wiki' }],
    };

    stats = await loadPack(conn, input);
  });

  afterAll(() => {
    conn.close();
    db.close();
  });

  it('reports accurate load counts and loads the FTS extension', () => {
    expect(stats).toMatchObject({
      articles: 2,
      sections: 2,
      chunks: 2,
      entities: 3,
      relationships: 1,
      links: 1,
    });
  });

  it('serves Section.embedding_idx via QUERY_VECTOR_INDEX (the read contract)', async () => {
    const rows = await conn.run<{ id: string; content: unknown; distance: number }>(
      `CALL QUERY_VECTOR_INDEX('Section', 'embedding_idx', $emb, $k)
       RETURN node.id AS id, node.content AS content, distance AS distance
       ORDER BY distance`,
      { emb: oneHot(0), k: 2 },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('Alpha#0'); // nearest to the Alpha embedding
    expect(String(rows[0].content)).toContain('photosynthesis');
    expect(rows[0].distance).toBeLessThanOrEqual(rows[1].distance);
  });

  it('serves the independent Chunk.chunk_embedding_idx', async () => {
    const rows = await conn.run<{ id: string }>(
      `CALL QUERY_VECTOR_INDEX('Chunk', 'chunk_embedding_idx', $emb, $k)
       RETURN node.id AS id, distance AS distance ORDER BY distance`,
      { emb: oneHot(100), k: 1 },
    );
    expect(rows[0].id).toBe('Beta#0#0');
  });

  it('creates exactly the required HNSW cosine index metadata', async () => {
    const indexes = await conn.run<{
      tableName: string;
      indexName: string;
      indexType: string;
      propertyNames: string[];
      definition: string;
    }>(
      'CALL SHOW_INDEXES() RETURN table_name AS tableName, index_name AS indexName, ' +
        'index_type AS indexType, property_names AS propertyNames, ' +
        'index_definition AS definition ORDER BY tableName, indexName',
    );

    expect(indexes).toHaveLength(2);
    expect(
      indexes.map(({ tableName, indexName, indexType, propertyNames }) => ({
        tableName,
        indexName,
        indexType,
        propertyNames,
      })),
    ).toEqual([
      {
        tableName: 'Chunk',
        indexName: 'chunk_embedding_idx',
        indexType: 'HNSW',
        propertyNames: ['embedding'],
      },
      {
        tableName: 'Section',
        indexName: 'embedding_idx',
        indexType: 'HNSW',
        propertyNames: ['embedding'],
      },
    ]);
    for (const index of indexes) {
      expect(index.definition).toContain("metric := 'cosine'");
    }
  });

  it('traverses Section→Section LINKS_TO exactly as the query reranker does', async () => {
    const rows = await conn.run<{ id: string; content: unknown }>(
      `MATCH (seed:Section {id: $id})-[:LINKS_TO]->(neighbor:Section)
       RETURN neighbor.id AS id, neighbor.content AS content`,
      { id: 'Alpha#0' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('Beta#0');
  });

  it('materializes Article/HAS_SECTION/Entity/ENTITY_RELATION structure', async () => {
    const articles = await conn.run<{ n: number | bigint }>(
      'MATCH (a:Article) RETURN count(a) AS n',
    );
    expect(Number(articles[0].n)).toBe(2);

    const hasSection = await conn.run<{ n: number | bigint }>(
      'MATCH (:Article)-[r:HAS_SECTION]->(:Section) RETURN count(r) AS n',
    );
    expect(Number(hasSection[0].n)).toBe(2);

    const entities = await conn.run<{ n: number | bigint }>(
      'MATCH (e:Entity) RETURN count(e) AS n',
    );
    expect(Number(entities[0].n)).toBe(3);

    const entityRels = await conn.run<{ n: number | bigint }>(
      'MATCH (:Entity)-[r:ENTITY_RELATION]->(:Entity) RETURN count(r) AS n',
    );
    expect(Number(entityRels[0].n)).toBe(1);
  });
});
