// @kgpacks/query — hybrid retrieval.
//
// Combines three signals into a single weighted score per node, mirroring the
// reference `hybrid_retrieve` (rysweet/agent-kgpacks wikigr/agent retriever module):
//   1. vector  — cosine similarity         (+= vector_weight * similarity)
//   2. graph   — LINKS_TO proximity        (+= graph_weight  * 0.5 per neighbor)
//   3. keyword — title CONTAINS match      (+= keyword_weight * 0.7 per match)
// The reference version keys by Article title; this node-level port keys by the
// node primary key over the same schema (`Section` nodes, `LINKS_TO` edges),
// preserving every weight and selection rule (first 3 seeds, first 3 keywords).

import type { Connection, Row } from '@kgpacks/db';

import {
  DEFAULT_STOP_WORDS,
  GRAPH_MATCH,
  KEYWORD_MATCH,
  MAX_GRAPH_SEEDS,
  MAX_KEYWORDS,
  MIN_KEYWORD_LENGTH,
} from './constants.js';
import { coerceContent, toIdString } from './row.js';
import type { Embedder, HybridWeights, RetrieverResult } from './types.js';
import { runVectorSearch, type VectorConfig } from './vector.js';

interface NodeMeta {
  rawId: unknown;
  content: string;
}

/**
 * Hybrid retrieval: blends vector, graph-proximity, and keyword signals into a
 * single ranking. Scores accumulate in insertion order so the first scored nodes
 * seed the graph traversal exactly as the reference does.
 */
export async function hybridRetrieve(
  conn: Connection,
  embedder: Embedder,
  query: string,
  k: number,
  weights: HybridWeights,
  config: VectorConfig,
  stopWords: ReadonlySet<string> = DEFAULT_STOP_WORDS,
): Promise<RetrieverResult[]> {
  const scored = new Map<string, number>();
  const meta = new Map<string, NodeMeta>();

  const accumulate = (id: string, rawId: unknown, content: string, delta: number): void => {
    scored.set(id, (scored.get(id) ?? 0) + delta);
    if (!meta.has(id)) {
      meta.set(id, { rawId, content });
    }
  };

  // Signal 1: vector similarity.
  const vectorHits = await runVectorSearch(conn, embedder, query, k, config);
  for (const hit of vectorHits) {
    accumulate(hit.id, hit.rawId, hit.content, weights.vector * hit.score);
  }

  // Signal 2: graph proximity from the first few scored nodes' LINKS_TO edges.
  const seedIds = [...scored.keys()].slice(0, MAX_GRAPH_SEEDS);
  for (const seedId of seedIds) {
    const seed = meta.get(seedId);
    if (seed === undefined) {
      continue;
    }
    const neighbors = await conn.run<Row>(
      `MATCH (seed:${config.nodeTable} {id: $id})-[:LINKS_TO]->(neighbor:${config.nodeTable})
       RETURN neighbor.id AS id, neighbor.content AS content
       LIMIT $limit`,
      { id: seed.rawId, limit: k },
    );
    for (const row of neighbors) {
      accumulate(
        toIdString(row.id),
        row.id,
        coerceContent(row.content),
        weights.graph * GRAPH_MATCH,
      );
    }
  }

  // Signal 3: keyword title matches (first 3 significant query terms).
  const keywords = query
    .split(/\s+/)
    .filter((word) => word.length > MIN_KEYWORD_LENGTH && !stopWords.has(word.toLowerCase()))
    .slice(0, MAX_KEYWORDS);
  for (const keyword of keywords) {
    const hits = await conn.run<Row>(
      `MATCH (s:${config.nodeTable}) WHERE lower(s.title) CONTAINS lower($kw)
       RETURN s.id AS id, s.content AS content
       LIMIT $limit`,
      { kw: keyword, limit: k },
    );
    for (const row of hits) {
      accumulate(
        toIdString(row.id),
        row.id,
        coerceContent(row.content),
        weights.keyword * KEYWORD_MATCH,
      );
    }
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id, score]) => ({ id, score, content: meta.get(id)?.content ?? '' }));
}
