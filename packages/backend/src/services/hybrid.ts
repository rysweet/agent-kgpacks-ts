// @kgpacks/backend — hybrid-search service.
//
// Blends semantic similarity (weight 0.7) with graph proximity (weight 0.3) from
// a seed article, returning the same `SearchResponse` shape as `/search` (with an
// empty `summary`, matching the reference hybrid path). The vector signal reuses the
// seed's lead-section embedding (best/nearest per article); the graph signal is a
// `LINKS_TO` BFS up to `max_hops`, scored closer = higher. Scores combine over the
// union of vector- and graph-matched articles.

import type { Connection, Row } from '@kgpacks/db';

import { ApiError } from '../errors.js';
import type { SearchResponse, SearchResult } from '../types.js';
import { clamp01, round1, toNullableText, toNumber, toNumberArray, toText } from '../util.js';

const VECTOR_INDEX = 'embedding_idx';
const NODE_TABLE = 'Section';
const OVERFETCH_CAP = 200;
const VECTOR_WEIGHT = 0.7;
const GRAPH_WEIGHT = 0.3;

export interface HybridParams {
  query: string;
  category?: string | null;
  maxHops: number;
  limit: number;
}

/** Performs hybrid search; throws `404` for an unknown seed. */
export async function hybridSearch(
  conn: Connection,
  params: HybridParams,
): Promise<SearchResponse> {
  const start = performance.now();
  const { query, category, limit } = params;
  const maxHops = Math.trunc(params.maxHops);
  // Self-protect regardless of caller: maxHops is interpolated into the Cypher
  // variable-length-path bound, so it must be a small integer (mirrors graph.ts).
  if (maxHops < 1 || maxHops > 3) {
    throw ApiError.invalidParameter(`max_hops must be between 1 and 3, got ${maxHops}`);
  }

  const exists = await conn.run<Row>('MATCH (a:Article {title: $title}) RETURN a.title AS title', {
    title: query,
  });
  if (exists.length === 0) {
    throw ApiError.notFound('Article not found');
  }

  const vectorScores = await vectorScoresByArticle(conn, query, limit);
  const graphScores = await graphScoresByArticle(conn, query, maxHops);

  const candidates = new Set<string>([...vectorScores.keys(), ...graphScores.keys()]);
  candidates.delete(query);
  if (candidates.size === 0) {
    return { query, results: [], total: 0, execution_time_ms: round1(performance.now() - start) };
  }

  const details = await fetchDetails(conn, [...candidates]);

  const combined: SearchResult[] = [];
  for (const article of candidates) {
    const detail = details.get(article);
    if (detail === undefined) continue;
    if (category && detail.category !== category) continue;
    const score =
      VECTOR_WEIGHT * (vectorScores.get(article) ?? 0) +
      GRAPH_WEIGHT * (graphScores.get(article) ?? 0);
    combined.push({
      article,
      similarity: clamp01(score),
      category: detail.category,
      word_count: detail.wordCount,
      summary: '',
    });
  }

  combined.sort((a, b) => b.similarity - a.similarity);
  const sliced = combined.slice(0, limit);

  return {
    query,
    results: sliced,
    total: sliced.length,
    execution_time_ms: round1(performance.now() - start),
  };
}

/** Best cosine similarity per article from the seed's lead-section embedding. */
async function vectorScoresByArticle(
  conn: Connection,
  seed: string,
  limit: number,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const leadRows = await conn.run<Row>(
    `MATCH (a:Article {title: $title})-[:HAS_SECTION {section_index: 0}]->(s:Section)
     RETURN s.embedding AS embedding`,
    { title: seed },
  );
  if (leadRows.length === 0) return scores;
  const embedding = toNumberArray(leadRows[0].embedding);
  if (embedding.length === 0) return scores;

  const k = Math.min(limit * 5, OVERFETCH_CAP);
  const hits = await conn.run<Row>(
    `CALL QUERY_VECTOR_INDEX('${NODE_TABLE}', '${VECTOR_INDEX}', $emb, $k)
     RETURN node.id AS section_id, distance AS distance
     ORDER BY distance`,
    { emb: embedding, k },
  );
  for (const row of hits) {
    const article = toText(row.section_id).split('#')[0];
    if (article === seed) continue;
    const similarity = clamp01(1 - toNumber(row.distance));
    const existing = scores.get(article);
    if (existing === undefined || similarity > existing) scores.set(article, similarity);
  }
  return scores;
}

/** Graph-proximity score per article: closer (fewer hops) scores higher. */
async function graphScoresByArticle(
  conn: Connection,
  seed: string,
  maxHops: number,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const rows = await conn.run<Row>(
    `MATCH path = (seed:Article {title: $seed})-[:LINKS_TO*0..${maxHops}]->(n:Article)
     WITH n.title AS title, min(length(path)) AS hops
     WHERE hops >= 1
     RETURN title, hops`,
    { seed },
  );
  for (const row of rows) {
    const hops = toNumber(row.hops);
    const proximity = clamp01((maxHops - hops + 1) / maxHops);
    scores.set(toText(row.title), proximity);
  }
  return scores;
}

interface ArticleDetailRow {
  category: string | null;
  wordCount: number;
}

async function fetchDetails(
  conn: Connection,
  titles: string[],
): Promise<Map<string, ArticleDetailRow>> {
  const map = new Map<string, ArticleDetailRow>();
  if (titles.length === 0) return map;
  const rows = await conn.run<Row>(
    `MATCH (a:Article)
     WHERE a.title IN $titles
     RETURN a.title AS title, a.category AS category, a.word_count AS word_count`,
    { titles },
  );
  for (const row of rows) {
    map.set(toText(row.title), {
      category: toNullableText(row.category),
      wordCount: toNumber(row.word_count),
    });
  }
  return map;
}
