// packages/query/test/lexical.test.ts
//
// End-to-end lexical retrieval over a tiny in-memory LadybugDB fixture carrying
// the v2 structured `Section` columns. Proves the load-bearing case: an EXACT
// import-path coordinate (`code.gitea.io/gitea`) that the vector encoder ranks
// poorly is still surfaced top-1 by the lexical union, and that a v1 pack
// (missing the structured columns) fails fast with a clear QueryError rather
// than silently returning nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Database, type Connection } from '@kgpacks/db';
import { BgeEmbedder } from '@kgpacks/embeddings';

import { createRetriever } from '../src/index.js';
import { QueryError } from '../src/errors.js';

interface Section {
  id: number;
  title: string;
  content: string;
  aliases: string;
  purls: string;
  cpes: string;
  affected_products: string;
  cve_id: string;
  ecosystems: string;
}

const SECTIONS: readonly Section[] = [
  {
    id: 1,
    title: 'CVE-2022-0001',
    content: 'A path traversal in the Gitea self-hosted Git service.',
    aliases: 'code.gitea.io/gitea; gitea',
    purls: 'pkg:golang/code.gitea.io/gitea',
    cpes: 'cpe:2.3:a:gitea:gitea:*:*:*:*:*:*:*:*',
    affected_products: 'Gitea',
    cve_id: 'CVE-2022-0001',
    ecosystems: 'go',
  },
  {
    id: 2,
    title: 'CVE-2022-0002',
    content:
      'The French Revolution was a period of radical political and social upheaval in France.',
    aliases: '',
    purls: '',
    cpes: '',
    affected_products: '',
    cve_id: 'CVE-2022-0002',
    ecosystems: '',
  },
  {
    id: 3,
    title: 'CVE-2022-0003',
    content: 'Photosynthesis converts sunlight into chemical energy stored as sugars.',
    aliases: 'example.com/photo',
    purls: 'pkg:npm/photo',
    cpes: '',
    affected_products: 'Photo',
    cve_id: 'CVE-2022-0003',
    ecosystems: 'npm',
  },
];

const V2_TABLE =
  'CREATE NODE TABLE Section(id INT64, title STRING, content STRING, embedding FLOAT[768], ' +
  'aliases STRING, purls STRING, cpes STRING, affected_products STRING, cve_id STRING, ' +
  'ecosystems STRING, PRIMARY KEY(id))';

describe('lexicalRetrieve — exact coordinate matching over structured fields', () => {
  const db = new Database();
  const conn: Connection = db.connect();
  const embedder = new BgeEmbedder();

  beforeAll(async () => {
    await conn.loadExtension('vector');
    await conn.run(V2_TABLE);

    const embeddings = await embedder.generate(SECTIONS.map((s) => s.content));
    for (let i = 0; i < SECTIONS.length; i++) {
      const s = SECTIONS[i];
      await conn.run(
        'CREATE (:Section {id: $id, title: $title, content: $content, embedding: $emb, ' +
          'aliases: $aliases, purls: $purls, cpes: $cpes, affected_products: $affected_products, ' +
          'cve_id: $cve_id, ecosystems: $ecosystems})',
        {
          id: s.id,
          title: s.title,
          content: s.content,
          emb: Array.from(embeddings[i]),
          aliases: s.aliases,
          purls: s.purls,
          cpes: s.cpes,
          affected_products: s.affected_products,
          cve_id: s.cve_id,
          ecosystems: s.ecosystems,
        },
      );
    }
    await conn.run(
      `CALL CREATE_VECTOR_INDEX('Section', 'embedding_idx', 'embedding', metric := 'cosine')`,
    );
  });

  afterAll(() => {
    conn.close();
    db.close();
  });

  it('surfaces an exact import-path match top-1 in lexical mode', async () => {
    const retriever = createRetriever(conn, { embedder });
    const results = await retriever.retrieve('code.gitea.io/gitea', { k: 3, mode: 'lexical' });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('1');
    // Full-query phrase match pins the score to 1.
    expect(results[0].score).toBe(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it('matches a CPE coordinate verbatim', async () => {
    const retriever = createRetriever(conn, { embedder });
    const results = await retriever.retrieve('cpe:2.3:a:gitea:gitea', { k: 3, mode: 'lexical' });
    expect(results.some((r) => r.id === '1')).toBe(true);
  });
});

describe('lexicalRetrieve — v1 pack (no structured columns) fails fast', () => {
  const db = new Database();
  const conn: Connection = db.connect();
  const embedder = new BgeEmbedder();

  beforeAll(async () => {
    await conn.loadExtension('vector');
    await conn.run(
      'CREATE NODE TABLE Section(id INT64, title STRING, content STRING, ' +
        'embedding FLOAT[768], PRIMARY KEY(id))',
    );
    const [emb] = await embedder.generate(['a lonely v1 section']);
    await conn.run(
      'CREATE (:Section {id: $id, title: $title, content: $content, embedding: $emb})',
      { id: 1, title: 'CVE-2022-0009', content: 'a lonely v1 section', emb: Array.from(emb) },
    );
    await conn.run(
      `CALL CREATE_VECTOR_INDEX('Section', 'embedding_idx', 'embedding', metric := 'cosine')`,
    );
  });

  afterAll(() => {
    conn.close();
    db.close();
  });

  it('throws a QueryError with a rebuild/hybrid hint', async () => {
    const retriever = createRetriever(conn, { embedder });
    await expect(retriever.retrieve('anything', { k: 3, mode: 'lexical' })).rejects.toThrow(
      QueryError,
    );
    await expect(retriever.retrieve('anything', { k: 3, mode: 'lexical' })).rejects.toThrow(
      /--mode hybrid/,
    );
  });
});
