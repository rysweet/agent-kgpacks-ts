// packages/query/test/vector.test.ts
//
// End-to-end vector retrieval over a tiny in-memory LadybugDB fixture, modeled on
// packages/db/test/spike-a.test.ts but driven through the public retriever and
// the REAL @kgpacks/embeddings BGE model (cold-cache download allowed; CI has
// network). Proves: embed query -> QUERY_VECTOR_INDEX -> ranked {id, score,
// content}, nearest semantic neighbor first, scores in [0, 1] and non-increasing.
//
// NOTE: the first embed call downloads the ONNX model; vitest.config.ts raises
// the timeouts accordingly.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database, type Connection } from '@kgpacks/db';
import { BgeEmbedder } from '@kgpacks/embeddings';

import { createRetriever } from '../src/index.js';

interface Section {
  id: number;
  title: string;
  content: string;
}

// Three semantically distinct passages; the query targets section 1 unambiguously.
const SECTIONS: readonly Section[] = [
  {
    id: 1,
    title: 'Photosynthesis',
    content:
      'Photosynthesis is the process by which green plants use sunlight to convert ' +
      'water and carbon dioxide into chemical energy stored as sugars.',
  },
  {
    id: 2,
    title: 'French Revolution',
    content:
      'The French Revolution was a period of radical political and social upheaval ' +
      'in France that began in 1789 and ended the absolute monarchy.',
  },
  {
    id: 3,
    title: 'Basketball',
    content:
      'Basketball is a team sport in which two teams score points by shooting a ball ' +
      'through the opposing team’s hoop on a rectangular court.',
  },
];

describe('vectorRetrieve — cosine ranking over an in-memory pack', () => {
  const db = new Database();
  const conn: Connection = db.connect();
  const embedder = new BgeEmbedder();

  beforeAll(async () => {
    await conn.loadExtension('vector');
    await conn.run(
      'CREATE NODE TABLE Section(id INT64, title STRING, content STRING, ' +
        'embedding FLOAT[768], PRIMARY KEY(id))',
    );

    const embeddings = await embedder.generate(SECTIONS.map((s) => s.content));
    for (let i = 0; i < SECTIONS.length; i++) {
      const s = SECTIONS[i];
      await conn.run(
        'CREATE (:Section {id: $id, title: $title, content: $content, embedding: $emb})',
        { id: s.id, title: s.title, content: s.content, emb: Array.from(embeddings[i]) },
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

  it('returns the nearest semantic neighbor first with valid descending scores', async () => {
    const retriever = createRetriever(conn, { embedder });

    const results = await retriever.retrieve('How do plants turn sunlight into energy?', { k: 3 });

    expect(results).toHaveLength(3);

    // Photosynthesis (id 1) is the unambiguous top hit.
    expect(results[0].id).toBe('1');
    expect(results[0].content).toContain('Photosynthesis');

    // Scores are cosine similarities in [0, 1], ranked non-increasing.
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('honors top-k', async () => {
    const retriever = createRetriever(conn, { embedder });
    const results = await retriever.retrieve('plants and sunlight', { k: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
  });
});

// Regression: a read connection that has NOT loaded the VECTOR extension must
// still work — the retriever loads it lazily before QUERY_VECTOR_INDEX. This
// mirrors the real CLI/backend scenario where the pack is built by one process
// and queried by another (a fresh connection), which previously failed with
// "function QUERY_VECTOR_INDEX is not defined".
describe('retriever auto-loads the VECTOR extension on a fresh connection', () => {
  let dir: string;
  let dbPath: string;
  const embedder = new BgeEmbedder();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kgpacks-query-ext-'));
    dbPath = join(dir, 'pack.db');

    // Build the pack with one connection (extension loaded only here).
    const buildDb = new Database(dbPath);
    const buildConn = buildDb.connect();
    await buildConn.loadExtension('vector');
    await buildConn.run(
      'CREATE NODE TABLE Section(id INT64, title STRING, content STRING, ' +
        'embedding FLOAT[768], PRIMARY KEY(id))',
    );
    const embeddings = await embedder.generate(SECTIONS.map((s) => s.content));
    for (let i = 0; i < SECTIONS.length; i++) {
      const s = SECTIONS[i];
      await buildConn.run(
        'CREATE (:Section {id: $id, title: $title, content: $content, embedding: $emb})',
        { id: s.id, title: s.title, content: s.content, emb: Array.from(embeddings[i]) },
      );
    }
    await buildConn.run(
      `CALL CREATE_VECTOR_INDEX('Section', 'embedding_idx', 'embedding', metric := 'cosine')`,
    );
    buildConn.close();
    buildDb.close();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('retrieves without the caller pre-loading the extension', async () => {
    const readDb = new Database(dbPath);
    const readConn = readDb.connect();
    try {
      // Deliberately do NOT call readConn.loadExtension('vector').
      const retriever = createRetriever(readConn, { embedder });
      const results = await retriever.retrieve('How do plants turn sunlight into energy?', {
        k: 1,
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('1');
    } finally {
      readConn.close();
      readDb.close();
    }
  });
});
