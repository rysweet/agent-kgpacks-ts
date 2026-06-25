// End-to-end buildPack with every external seam mocked, then read the pack back.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Database, type Connection } from '@kgpacks/db';

import { buildPack } from '../src/index.js';
import type { Article, BuildPackResult, ExtractionResult, Extractor } from '../src/types.js';
import { makeEmbedder, makeExtractor, makeFetcher, wikiHtml } from './helpers.js';

const A_URL = 'https://en.wikipedia.org/wiki/A';
const B_URL = 'https://en.wikipedia.org/wiki/B';

describe('buildPack — offline end-to-end', () => {
  const db = new Database();
  let conn: Connection;
  let result: BuildPackResult;
  const embedder = makeEmbedder();

  beforeAll(async () => {
    conn = db.connect();

    const fetcher = makeFetcher({
      [A_URL]: wikiHtml('A', 'A is a topic about light.', [B_URL]),
      [B_URL]: wikiHtml('B', 'B is a topic about sport.', [A_URL]),
    });
    const extractor = makeExtractor({
      entities: [{ name: 'Shared Entity', type: 'concept' }],
      relationships: [],
      keyFacts: ['a fact'],
    });

    result = await buildPack({
      seeds: [A_URL],
      maxDepth: 1,
      maxArticles: 10,
      fetcher,
      embedder,
      extractor,
      connection: conn,
    });
  });

  afterAll(() => {
    conn.close();
    db.close();
  });

  it('ingests both articles and reports the loaded model', () => {
    expect(result.articles.map((a) => a.title).sort()).toEqual(['A', 'B']);
    // Each page yields a lead + History section.
    expect(result.sections.length).toBe(4);
    expect(result.chunks.length).toBeGreaterThanOrEqual(4);
    // Entity is deduped across the two articles.
    expect(result.entities.map((e) => e.name)).toEqual(['Shared Entity']);
    // A→B and B→A links (both endpoints ingested).
    expect(result.links).toHaveLength(2);
    expect(result.dbPath).toBe(':memory:');
  });

  it('produces a pack readable via QUERY_VECTOR_INDEX', async () => {
    const [queryVec] = await embedder.generate(['A is a topic about light.']);
    const rows = await conn.run<{ id: string; content: unknown }>(
      `CALL QUERY_VECTOR_INDEX('Section', 'embedding_idx', $emb, $k)
       RETURN node.id AS id, node.content AS content, distance AS distance
       ORDER BY distance`,
      { emb: Array.from(queryVec), k: 10 },
    );
    expect(rows.length).toBe(4);
    expect(rows[0].id).toBe('A#0'); // nearest to the queried section text
  });

  it('wires Section→Section LINKS_TO between the two articles', async () => {
    const rows = await conn.run<{ id: string }>(
      `MATCH (s:Section {id: $id})-[:LINKS_TO]->(n:Section) RETURN n.id AS id`,
      { id: 'A#0' },
    );
    expect(rows.map((r) => r.id)).toEqual(['B#0']);
  });

  it('persists each Article expansion_depth (seed = 0, expanded neighbour = 1)', async () => {
    const rows = await conn.run<{ title: string; depth: number }>(
      `MATCH (a:Article) RETURN a.title AS title, a.expansion_depth AS depth ORDER BY title`,
    );
    expect(rows).toEqual([
      { title: 'A', depth: 0 },
      { title: 'B', depth: 1 },
    ]);
  });
});

describe('buildPack — per-article fault isolation', () => {
  const db = new Database();
  let conn: Connection;
  let result: BuildPackResult;
  const embedder = makeEmbedder();

  beforeAll(async () => {
    conn = db.connect();

    const fetcher = makeFetcher({
      [A_URL]: wikiHtml('A', 'A is a topic about light.', [B_URL]),
      [B_URL]: wikiHtml('B', 'B is a topic about sport.', [A_URL]),
    });
    // Extraction fails for B only — one bad article must not abort the build.
    const flakyExtractor: Extractor = {
      async extract(article: Article): Promise<ExtractionResult> {
        if (article.title === 'B') {
          throw new Error('extraction blew up on B');
        }
        return {
          entities: [{ name: 'Shared Entity', type: 'concept' }],
          relationships: [],
          keyFacts: [],
        };
      },
    };

    result = await buildPack({
      seeds: [A_URL],
      maxDepth: 1,
      maxArticles: 10,
      fetcher,
      embedder,
      extractor: flakyExtractor,
      connection: conn,
    });
  });

  afterAll(() => {
    conn.close();
    db.close();
  });

  it('skips the failing article but still loads the healthy one', () => {
    expect(result.articles.map((a) => a.title)).toEqual(['A']);
    expect(result.skipped).toEqual([{ title: 'B', reason: 'extraction blew up on B' }]);
  });

  it('drops links to/from the skipped article (it is not a node)', () => {
    // A→B and B→A both reference B, which never loaded ⇒ no edges survive.
    expect(result.links).toHaveLength(0);
  });

  it('produces a queryable pack containing only the loaded article', async () => {
    const rows = await conn.run<{ id: string }>(`MATCH (s:Section) RETURN s.id AS id ORDER BY id`);
    expect(rows.every((r) => r.id.startsWith('A#'))).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('buildPack — releases the database even if extractor.close() throws', () => {
  it('closes conn/database so the on-disk pack is not handle-leaked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kgpacks-buildpack-leak-'));
    const dbPath = join(dir, 'pack.db');
    try {
      const fetcher = makeFetcher({ [A_URL]: wikiHtml('A', 'A is a topic about light.', []) });
      // Extraction succeeds, but the extractor's teardown throws — as a real LLM
      // subprocess shutdown can. The build must still close the database.
      const throwingExtractor: Extractor = {
        async extract(): Promise<ExtractionResult> {
          return { entities: [], relationships: [], keyFacts: [] };
        },
        async close(): Promise<void> {
          throw new Error('extractor teardown boom');
        },
      };

      await expect(
        buildPack({
          seeds: [A_URL],
          maxDepth: 0,
          maxArticles: 5,
          fetcher,
          embedder: makeEmbedder(),
          extractor: throwingExtractor,
          dbPath,
        }),
      ).rejects.toThrow('extractor teardown boom');

      // If the conn/Database handle had leaked, re-opening the same on-disk pack
      // would fail with a LadybugDB lock error. A clean re-open + query proves the
      // database was closed despite the extractor.close() throw.
      const db2 = new Database(dbPath);
      const conn2 = db2.connect();
      const rows = await conn2.run<{ n: number | bigint }>(
        `MATCH (s:Section) RETURN count(s) AS n`,
      );
      expect(Number(rows[0].n)).toBeGreaterThan(0);
      conn2.close();
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
