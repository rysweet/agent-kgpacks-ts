// @kgpacks/ingestion — public entry point.
//
// The WRITE side of the platform: `buildPack(config)` runs the end-to-end pipeline
//
//   seeds ─▶ fetch (SSRF-safe) ─▶ clean/sectionize ─▶ extract (LLM) ─▶ chunk
//         ─▶ embed (BGE, document mode) ─▶ load (LadybugDB) ─▶ expand (bounded BFS)
//
// producing a LadybugDB pack that @kgpacks/query reads back unchanged. Every
// external dependency (HTTP fetch, the embedding model, the LLM extractor, the
// database connection) is an injectable seam with a real default, so unit tests run
// fully offline.

import { BgeEmbedder } from '@kgpacks/embeddings';
import { Database, type Connection } from '@kgpacks/db';

import { chunkArticle } from './chunking.js';
import { createLlmExtractor } from './extraction.js';
import { expandFromSeeds } from './expansion.js';
import { createSafeFetcher } from './fetcher.js';
import { loadPack, type LoadableArticle } from './loader.js';
import { articleTitleFromUrl, fetchArticle } from './sources.js';
import type {
  Article,
  ArticleLink,
  BuildPackConfig,
  BuildPackResult,
  Chunk,
  Embedder,
  Entity,
  Extractor,
  Relationship,
  Section,
  SkippedArticle,
} from './types.js';

/** Normalizes a thrown value to a string message for the skipped-article report. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Embeds a list of texts, tolerating an empty input (no model load). */
async function embedAll(embedder: Embedder, texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) {
    return [];
  }
  return embedder.generate(texts);
}

/**
 * Builds a knowledge pack from `config.seeds` and returns what was loaded.
 *
 * When `config.connection` is supplied the caller owns it (so the pack can be
 * queried back in the same process — e.g. tests); otherwise a database is opened at
 * `config.dbPath` (default in-memory) and closed before returning.
 */
export async function buildPack(config: BuildPackConfig): Promise<BuildPackResult> {
  const fetcher = config.fetcher ?? createSafeFetcher();
  const embedder: Embedder = config.embedder ?? new BgeEmbedder();
  const extractor: Extractor =
    config.extractor ?? createLlmExtractor({ transport: config.transport });
  const maxDepth = config.maxDepth ?? 1;
  const maxArticles = config.maxArticles ?? 50;

  // Resolve the database/connection (own it only when we opened it).
  const ownConnection = config.connection === undefined;
  const dbPath = config.dbPath ?? ':memory:';
  let database: Database | undefined;
  let conn: Connection;
  if (config.connection !== undefined) {
    conn = config.connection;
  } else {
    database = new Database(dbPath);
    conn = database.connect();
  }

  try {
    // 1–2. Fetch + clean + sectionize, breadth-first within the configured bounds.
    const expanded = await expandFromSeeds(config.seeds, (url) => fetchArticle(url, fetcher), {
      maxDepth,
      maxArticles,
    });

    // 3–5. Extract, chunk, and embed each article into a loadable record.
    // Fail-soft per article: one article's extract/embed failure (a transient LLM
    // error, a model OOM, a malformed section) must not abort the whole build, the
    // same way an unreachable source is skipped in expansion.ts. Skipped articles
    // are reported in the result rather than silently dropped.
    const loadables: LoadableArticle[] = [];
    const skipped: SkippedArticle[] = [];
    for (const { article, depth } of expanded) {
      try {
        const chunks = chunkArticle(article, config.chunk);
        const [sectionEmbeddings, chunkEmbeddings, extraction] = await Promise.all([
          embedAll(
            embedder,
            article.sections.map((s) => embeddableSectionText(s.title, s.content)),
          ),
          embedAll(
            embedder,
            chunks.map((c) => c.content),
          ),
          extractor.extract(article),
        ]);
        loadables.push({
          article,
          sectionEmbeddings,
          chunkEmbeddings,
          chunks,
          extraction,
          expansionDepth: depth,
        });
      } catch (error) {
        skipped.push({ title: article.title, reason: errorMessage(error) });
      }
    }

    // 6. Article→article links, restricted to the articles that actually loaded
    // (a skipped article is not a node, so links to/from it must be dropped).
    const loadedTitles = new Set(loadables.map((l) => l.article.title));
    const links = collectLinks(
      loadables.map((l) => l.article),
      loadedTitles,
    );

    // 7. Write the pack (schema, nodes/edges, vector indexes).
    await loadPack(conn, { articles: loadables, links });

    return summarize(dbPath, loadables, links, skipped);
  } finally {
    // Release each resource independently: a throwing extractor.close() (the LLM
    // subprocess teardown can report errors) must NOT skip the LadybugDB close,
    // or the connection + on-disk pack.db handle leak — even on an otherwise
    // successful build.
    try {
      if (extractor.close) {
        await extractor.close();
      }
    } finally {
      if (ownConnection) {
        conn.close();
        database?.close();
      }
    }
  }
}

/** Section embedding text: the heading helps disambiguate short bodies (lead has none). */
function embeddableSectionText(title: string, content: string): string {
  return content.length > 0 ? content : title;
}

/** Builds article→article links restricted to ingested endpoints, deduped. */
function collectLinks(articles: Article[], loadedTitles: Set<string>): ArticleLink[] {
  const links: ArticleLink[] = [];
  const seen = new Set<string>();
  for (const article of articles) {
    for (const url of article.links) {
      const target = articleTitleFromUrl(url);
      if (target === article.title || !loadedTitles.has(target)) {
        continue;
      }
      const key = `${article.title}\u0000${target}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      links.push({ from: article.title, to: target, linkType: 'wiki' });
    }
  }
  return links;
}

/** Aggregates the per-article load records into the public result shape. */
function summarize(
  dbPath: string,
  loadables: LoadableArticle[],
  links: ArticleLink[],
  skipped: SkippedArticle[],
): BuildPackResult {
  const sections: Section[] = loadables.flatMap((l) => l.article.sections);
  const chunks: Chunk[] = loadables.flatMap((l) => l.chunks);

  const entitiesByName = new Map<string, Entity>();
  const relationships: Relationship[] = [];
  for (const l of loadables) {
    for (const entity of l.extraction.entities) {
      const id = entity.name.trim();
      if (id !== '' && !entitiesByName.has(id)) {
        entitiesByName.set(id, entity);
      }
    }
    relationships.push(...l.extraction.relationships);
  }

  return {
    dbPath,
    articles: loadables.map((l) => l.article),
    sections,
    chunks,
    entities: [...entitiesByName.values()],
    relationships,
    links,
    skipped,
  };
}

// ── Public API surface ────────────────────────────────────────────────────────

export { createSafeFetcher, assertUrlAllowed, isBlockedAddress } from './fetcher.js';
export type { SafeFetcherOptions } from './fetcher.js';
export {
  fetchArticle,
  parseArticleHtml,
  htmlToSections,
  htmlToText,
  extractLinks,
  extractTitle,
  articleTitleFromUrl,
  inferCategories,
  decodeEntities,
  collapseWhitespace,
} from './sources.js';
export {
  createLlmExtractor,
  buildExtractionPrompt,
  parseExtractionResponse,
  normalizeRelation,
  sanitizeEntities,
  sanitizeRelationships,
  sanitizeKeyFacts,
} from './extraction.js';
export type { LlmExtractorOptions } from './extraction.js';
export { chunkArticle, windowText } from './chunking.js';
export { expandFromSeeds } from './expansion.js';
export type { ExpansionOptions, ExpandedArticle } from './expansion.js';
export { loadPack, createSchema, loadExtensions, buildVectorIndexes } from './loader.js';
export type { LoadableArticle, LoadPackInput, LoadPackStats } from './loader.js';
export { createPackWriter } from './streaming-loader.js';
export type { PackWriter, PackWriterOptions, PackWriterStats } from './streaming-loader.js';
export {
  EMBEDDING_DIM,
  SECTION_TABLE,
  SECTION_VECTOR_INDEX,
  CHUNK_TABLE,
  CHUNK_VECTOR_INDEX,
  EXTENSIONS,
  NODE_TABLE_DDL,
  REL_TABLE_DDL,
  VECTOR_INDEX_DDL,
} from './schema.js';
export { IngestionError, BlockedUrlError, FetchError, ExtractionError } from './errors.js';
export type {
  Article,
  ArticleLink,
  BuildPackConfig,
  BuildPackResult,
  Chunk,
  ChunkOptions,
  Embedder,
  Entity,
  ExtractionResult,
  Extractor,
  FetchImpl,
  FetchInit,
  FetchResponse,
  Fetcher,
  LookupFn,
  Relationship,
  ResolvedAddress,
  Section,
  SkippedArticle,
} from './types.js';
