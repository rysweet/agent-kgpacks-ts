import { createHash } from 'node:crypto';

import { chunkArticle } from './chunking.js';
import { CVE_ADAPTER_VERSION, cveToGraph } from './cve-adapter.js';
import type { LoadableArticle } from './loader.js';
import type { Embedder } from './types.js';

type Row = Record<string, unknown>;

interface ArticleCopyConnection {
  run<T extends Row = Row>(statement: string, params?: Record<string, unknown>): Promise<T[]>;
}

interface ArticleRows {
  articles: Row[];
  sections: Row[];
  chunks: Row[];
}

function sourceHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function asNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, Number);
  throw new Error('base pack contains an invalid embedding');
}

function groupByArticle(rows: Row[]): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const article = String(row.article);
    const current = grouped.get(article);
    if (current) current.push(row);
    else grouped.set(article, [row]);
  }
  return grouped;
}

async function readArticleRows(
  connection: ArticleCopyConnection,
  titles: string[],
): Promise<ArticleRows> {
  const params = { titles };
  const articles = await connection.run(
    'MATCH (a:Article), (src:ArticleSource) WHERE a.title = src.title ' +
      'AND a.title IN $titles ' +
      'RETURN a.title AS title, a.category AS category, a.expansion_depth AS depth, ' +
      'src.payload AS payload, src.payload_sha256 AS payloadHash, ' +
      'src.extractor_version AS extractorVersion ORDER BY title',
    params,
  );
  const sections = await connection.run(
    'MATCH (a:Article)-[r:HAS_SECTION]->(s:Section) ' +
      'WHERE a.title IN $titles ' +
      'RETURN a.title AS article, r.section_index AS idx, s.id AS id, s.title AS title, ' +
      's.content AS content, s.embedding AS embedding, s.level AS level, s.cve_id AS cveId, ' +
      's.affected_products AS affectedProducts, s.aliases AS aliases, s.cpes AS cpes, ' +
      's.purls AS purls, s.ecosystems AS ecosystems ORDER BY article, idx',
    params,
  );
  const chunks = await connection.run(
    'MATCH (a:Article)-[r:HAS_CHUNK]->(c:Chunk) ' +
      'WHERE a.title IN $titles ' +
      'RETURN a.title AS article, r.section_index AS sectionIndex, r.chunk_index AS chunkIndex, ' +
      'c.id AS id, c.content AS content, c.embedding AS embedding ' +
      'ORDER BY article, sectionIndex, chunkIndex',
    params,
  );
  return { articles, sections, chunks };
}

function loadableFor(row: Row, sections: Row[], chunks: Row[]): LoadableArticle {
  const title = String(row.title);
  const sourcePayload = String(row.payload);
  const graph = cveToGraph(JSON.parse(sourcePayload));
  if (!graph || graph.article.title !== title) {
    throw new Error(`base article source does not reproduce ${title}`);
  }
  if (
    String(row.payloadHash) !== sourceHash(sourcePayload) ||
    String(row.extractorVersion) !== CVE_ADAPTER_VERSION
  ) {
    throw new Error(`base article provenance is invalid for ${title}`);
  }
  const articleChunks = chunks.map((chunk) => ({
    id: String(chunk.id),
    content: String(chunk.content),
    articleTitle: title,
    sectionIndex: Number(chunk.sectionIndex),
    chunkIndex: Number(chunk.chunkIndex),
  }));
  return {
    article: graph.article,
    sectionEmbeddings: sections.map((section) => asNumberArray(section.embedding)),
    chunks: articleChunks,
    chunkEmbeddings: chunks.map((chunk) => asNumberArray(chunk.embedding)),
    extraction: graph.extraction,
    expansionDepth: Number(row.depth),
    sourcePayload,
    sourcePayloadHash: String(row.payloadHash),
    extractorVersion: String(row.extractorVersion),
  };
}

function assembleLoadables(rows: ArticleRows, titles: string[]): Map<string, LoadableArticle> {
  const sections = groupByArticle(rows.sections);
  const chunks = groupByArticle(rows.chunks);
  const byTitle = new Map<string, LoadableArticle>();
  for (const row of rows.articles) {
    const title = String(row.title);
    byTitle.set(title, loadableFor(row, sections.get(title) ?? [], chunks.get(title) ?? []));
  }
  if (byTitle.size !== rows.articles.length || byTitle.size !== new Set(titles).size) {
    throw new Error('base article provenance is incomplete');
  }
  return byTitle;
}

export async function toLoadable(payload: string, embedder: Embedder): Promise<LoadableArticle> {
  let record: unknown;
  try {
    record = JSON.parse(payload);
  } catch (error) {
    throw new Error(`invalid CVE source payload: ${(error as Error).message}`);
  }
  const graph = cveToGraph(record);
  if (!graph) throw new Error('CVE source payload is rejected or has no usable description');
  const chunks = chunkArticle(graph.article, { size: 4000, overlap: 0 });
  const sectionCount = graph.article.sections.length;
  const embeddings = await embedder.generate([
    ...graph.article.sections.map((section) => section.content),
    ...chunks.map((chunk) => chunk.content),
  ]);
  return {
    article: graph.article,
    sectionEmbeddings: embeddings.slice(0, sectionCount),
    chunks,
    chunkEmbeddings: embeddings.slice(sectionCount),
    extraction: graph.extraction,
    sourcePayload: payload,
    sourcePayloadHash: sourceHash(payload),
    extractorVersion: CVE_ADAPTER_VERSION,
  };
}

export async function readBaseLoadables(
  connection: ArticleCopyConnection,
  titles: string[],
): Promise<Map<string, LoadableArticle>> {
  if (titles.length === 0) return new Map();
  try {
    return assembleLoadables(await readArticleRows(connection, titles), titles);
  } catch (error) {
    throw new Error(
      `base pack is not provenance-capable and must be rebuilt from source: ${(error as Error).message}`,
      { cause: error },
    );
  }
}
