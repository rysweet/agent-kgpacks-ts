// @kgpacks/backend — semantic-search service.
//
// Direct-Cypher port of the reference `services/search_service.SearchService`.
// Treats `query` as a seed article title: reads that article's lead-section
// embedding, runs a cosine `QUERY_VECTOR_INDEX` over the `Section` table, maps
// section hits back to their articles (best/nearest per article, self excluded),
// enriches with category/word-count/summary, then filters by category/threshold,
// sorts by similarity descending, and slices to `limit`.

import type { Connection, Row } from '@kgpacks/db';

import { ApiError } from '../errors.js';
import type {
  AutocompleteResponse,
  AutocompleteResult,
  SearchResponse,
  SearchResult,
} from '../types.js';
import { clamp01, round1, toNullableText, toNumber, toNumberArray, toText } from '../util.js';
import { getArticleSummaries } from './summary.js';

const VECTOR_INDEX = 'embedding_idx';
const NODE_TABLE = 'Section';
const OVERFETCH_CAP = 200;

export interface SemanticSearchParams {
  query: string;
  category?: string | null;
  limit: number;
  threshold: number;
}

interface ArticleMatch {
  article: string;
  distance: number;
  similarity: number;
}

/** Performs semantic search; throws `404 NOT_FOUND` when the seed is unknown. */
export async function semanticSearch(
  conn: Connection,
  params: SemanticSearchParams,
): Promise<SearchResponse> {
  const start = performance.now();
  const { query, category, limit, threshold } = params;

  const exists = await conn.run<Row>('MATCH (a:Article {title: $title}) RETURN a.title AS title', {
    title: query,
  });
  if (exists.length === 0) {
    throw ApiError.notFound('Article not found');
  }

  const results = await searchImpl(conn, query, category ?? null, limit);
  const filtered = results
    .filter((r) => r.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return {
    query,
    results: filtered,
    total: filtered.length,
    execution_time_ms: round1(performance.now() - start),
  };
}

async function searchImpl(
  conn: Connection,
  queryTitle: string,
  category: string | null,
  topK: number,
): Promise<SearchResult[]> {
  // Lead-section (index 0) embedding of the query article.
  const leadRows = await conn.run<Row>(
    `MATCH (a:Article {title: $title})-[:HAS_SECTION {section_index: 0}]->(s:Section)
     RETURN s.embedding AS embedding`,
    { title: queryTitle },
  );
  if (leadRows.length === 0) return [];
  const embedding = toNumberArray(leadRows[0].embedding);
  if (embedding.length === 0) return [];

  // Over-fetch for per-article aggregation, capped like the reference service.
  const k = Math.min(topK * 5, OVERFETCH_CAP);
  const hits = await conn.run<Row>(
    `CALL QUERY_VECTOR_INDEX('${NODE_TABLE}', '${VECTOR_INDEX}', $emb, $k)
     RETURN node.id AS section_id, distance AS distance
     ORDER BY distance`,
    { emb: embedding, k },
  );

  // Aggregate to the best (nearest) match per article, excluding self-matches.
  const best = new Map<string, ArticleMatch>();
  for (const row of hits) {
    const sectionId = toText(row.section_id);
    const article = sectionId.split('#')[0];
    if (article === queryTitle) continue;
    const distance = toNumber(row.distance);
    const existing = best.get(article);
    if (existing === undefined || distance < existing.distance) {
      best.set(article, { article, distance, similarity: clamp01(1 - distance) });
    }
  }

  const titles = [...best.keys()];
  if (titles.length === 0) return [];

  const details = await fetchDetails(conn, titles);
  const summaries = await getArticleSummaries(conn, titles);

  const results: SearchResult[] = [];
  for (const match of best.values()) {
    const detail = details.get(match.article);
    if (detail === undefined) continue;
    if (category && detail.category !== category) continue;
    results.push({
      article: match.article,
      similarity: match.similarity,
      category: detail.category,
      word_count: detail.wordCount,
      summary: summaries.get(match.article) ?? '',
    });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
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

/**
 * Title autocomplete: case-insensitive `STARTS WITH` (prefix) matches first, then
 * `CONTAINS` matches to fill out the list. Ported from the reference
 * `SearchService.autocomplete`. Throws `400` when `q` is shorter than 2 chars.
 */
export async function autocomplete(
  conn: Connection,
  q: string,
  limit: number,
): Promise<AutocompleteResponse> {
  if (q.length < 2) {
    throw ApiError.invalidParameter('Query must be at least 2 characters');
  }

  const suggestions: AutocompleteResult[] = [];

  const prefixRows = await conn.run<Row>(
    `MATCH (a:Article)
     WHERE lower(a.title) STARTS WITH lower($prefix)
     RETURN a.title AS title, a.category AS category
     ORDER BY a.title ASC
     LIMIT $limit`,
    { prefix: q, limit },
  );
  for (const row of prefixRows) {
    suggestions.push({
      title: toText(row.title),
      category: toNullableText(row.category),
      match_type: 'prefix',
    });
  }

  if (suggestions.length < limit) {
    const remaining = limit - suggestions.length;
    const containsRows = await conn.run<Row>(
      `MATCH (a:Article)
       WHERE lower(a.title) CONTAINS lower($substring)
         AND NOT lower(a.title) STARTS WITH lower($prefix)
       RETURN a.title AS title, a.category AS category
       ORDER BY a.title ASC
       LIMIT $limit`,
      { substring: q, prefix: q, limit: remaining },
    );
    for (const row of containsRows) {
      suggestions.push({
        title: toText(row.title),
        category: toNullableText(row.category),
        match_type: 'contains',
      });
    }
  }

  return { query: q, suggestions, total: suggestions.length };
}
