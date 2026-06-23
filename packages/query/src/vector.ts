// @kgpacks/query — vector retrieval.
//
// Embeds the query with the BGE query encoder, runs a cosine vector search over a
// LadybugDB pack via `CALL QUERY_VECTOR_INDEX`, and returns nodes ranked by
// similarity. Ported from the reference `semantic_search` vector path
// (rysweet/agent-kgpacks): `score = clamp(1 - distance, 0, 1)`, nearest first.

import type { Connection, Row } from '@kgpacks/db';

import { clamp01, coerceContent, toIdString } from './row.js';
import type { Embedder, RetrieverResult } from './types.js';

/** Schema coordinates for the vector index to search. */
export interface VectorConfig {
  /** Node table holding the embeddings (e.g. `Section`). */
  nodeTable: string;
  /** Vector index name created over that table (e.g. `embedding_idx`). */
  vectorIndex: string;
}

/** A vector hit enriched with its raw primary key (for graph re-binding). */
export interface ScoredNode {
  /** Raw primary key as returned by the driver (`number | bigint`). */
  rawId: unknown;
  /** Stable string form of {@link ScoredNode.rawId}. */
  id: string;
  /** Cosine similarity `1 - distance`, clamped to `[0, 1]`. */
  score: number;
  /** The node's section content. */
  content: string;
}

/**
 * Runs the cosine vector search and returns hits enriched with `rawId`.
 *
 * `nodeTable`/`vectorIndex` are trusted configuration (developer-supplied, never
 * end-user input) and are interpolated as the procedure's string-literal
 * arguments, mirroring `CALL QUERY_VECTOR_INDEX('Section', 'embedding_idx', ...)`.
 * The embedding vector and `k` are bound as parameters.
 */
export async function runVectorSearch(
  conn: Connection,
  embedder: Embedder,
  query: string,
  k: number,
  config: VectorConfig,
): Promise<ScoredNode[]> {
  const [embedding] = await embedder.generateQuery([query]);
  if (embedding === undefined) {
    return [];
  }

  // QUERY_VECTOR_INDEX binds a plain numeric array, not a Float32Array.
  const emb = Array.from(embedding);

  const rows = await conn.run<Row>(
    `CALL QUERY_VECTOR_INDEX('${config.nodeTable}', '${config.vectorIndex}', $emb, $k)
     RETURN node.id AS id, node.content AS content, distance AS distance
     ORDER BY distance`,
    { emb, k },
  );

  return rows.map((row) => ({
    rawId: row.id,
    id: toIdString(row.id),
    score: clamp01(1 - Number(row.distance)),
    content: coerceContent(row.content),
  }));
}

/** Vector retrieval: top-k nodes ranked by cosine similarity (highest first). */
export async function vectorRetrieve(
  conn: Connection,
  embedder: Embedder,
  query: string,
  k: number,
  config: VectorConfig,
): Promise<RetrieverResult[]> {
  const hits = await runVectorSearch(conn, embedder, query, k, config);
  return hits.map(({ id, score, content }) => ({ id, score, content }));
}
