// @kgpacks/backend — graph-neighborhood service.
//
// Direct-Cypher port of the reference `services/graph_service.GraphService`. Returns
// the nodes reachable within `depth` `LINKS_TO` hops of the seed (seed = depth 0),
// de-duplicated in traversal order, plus the edges among them. `depth` is
// interpolated into the variable-length pattern (LadybugDB cannot parameterize
// path bounds) after strict 1–3 validation, so injection is impossible.

import type { Connection, Row } from '@kgpacks/db';

import { ApiError } from '../errors.js';
import type { GraphEdge, GraphNode, GraphResponse } from '../types.js';
import { round1, toNullableText, toNumber, toText } from '../util.js';
import { getArticleSummaries } from './summary.js';

const EDGE_QUERY_LIMIT = 1000;

export interface GraphParams {
  article: string;
  depth: number;
  limit: number;
  category?: string | null;
}

interface NeighborRow {
  title: string;
  category: string | null;
  wordCount: number;
  depth: number;
}

/** Builds the graph neighborhood; throws `404` for an unknown seed. */
export async function getGraphNeighbors(
  conn: Connection,
  params: GraphParams,
): Promise<GraphResponse> {
  const start = performance.now();
  const { article, limit, category } = params;
  const depth = Math.trunc(params.depth);
  if (depth < 1 || depth > 3) {
    throw ApiError.invalidParameter(`depth must be between 1 and 3, got ${depth}`);
  }

  const exists = await conn.run<Row>('MATCH (a:Article {title: $title}) RETURN a.title AS title', {
    title: article,
  });
  if (exists.length === 0) {
    throw ApiError.notFound('Article not found');
  }

  const categoryClause = category ? 'WHERE neighbor.category = $category' : '';
  const cypher = `MATCH path = (seed:Article {title: $seed})-[:LINKS_TO*0..${depth}]->(neighbor:Article)
     ${categoryClause}
     WITH neighbor, length(path) AS depth
     ORDER BY depth ASC, neighbor.title ASC
     LIMIT $limit
     RETURN neighbor.title AS title, neighbor.category AS category,
            neighbor.word_count AS word_count, depth`;
  const params2: Record<string, unknown> = { seed: article, limit };
  if (category) params2.category = category;

  const rows = await conn.run<Row>(cypher, params2);

  // De-duplicate by title preserving traversal order (first = lowest depth).
  const seen = new Set<string>();
  const nodeRows: NeighborRow[] = [];
  for (const row of rows) {
    const title = toText(row.title);
    if (seen.has(title)) continue;
    seen.add(title);
    nodeRows.push({
      title,
      category: toNullableText(row.category),
      wordCount: toNumber(row.word_count),
      depth: toNumber(row.depth),
    });
  }

  const titles = nodeRows.map((r) => r.title);
  const linkCounts = await fetchLinkCounts(conn, titles);
  const summaries = await getArticleSummaries(conn, titles);

  const nodes: GraphNode[] = nodeRows.map((row) => ({
    id: row.title,
    title: row.title,
    category: row.category,
    word_count: row.wordCount,
    depth: row.depth,
    links_count: linkCounts.get(row.title) ?? 0,
    summary: summaries.get(row.title) ?? '',
  }));

  const edges = await fetchEdges(conn, titles);

  return {
    seed: article,
    nodes,
    edges,
    total_nodes: nodes.length,
    total_edges: edges.length,
    execution_time_ms: round1(performance.now() - start),
  };
}

async function fetchLinkCounts(conn: Connection, titles: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (titles.length === 0) return counts;
  const rows = await conn.run<Row>(
    `MATCH (a:Article)-[:LINKS_TO]->(t:Article)
     WHERE a.title IN $titles
     RETURN a.title AS title, COUNT(t) AS links`,
    { titles },
  );
  for (const row of rows) {
    counts.set(toText(row.title), toNumber(row.links));
  }
  return counts;
}

async function fetchEdges(conn: Connection, titles: string[]): Promise<GraphEdge[]> {
  if (titles.length <= 1) return [];
  const rows = await conn.run<Row>(
    `MATCH (source:Article)-[:LINKS_TO]->(target:Article)
     WHERE source.title IN $titles AND target.title IN $titles
     RETURN source.title AS source, target.title AS target
     LIMIT ${EDGE_QUERY_LIMIT}`,
    { titles },
  );
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const source = toText(row.source);
    const target = toText(row.target);
    const key = `${source}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source, target, type: 'internal', weight: 1.0 });
  }
  return edges;
}
