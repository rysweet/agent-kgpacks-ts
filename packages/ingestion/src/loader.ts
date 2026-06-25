// @kgpacks/ingestion — LadybugDB loader.
//
// Writes the cleaned/extracted/embedded document model into a LadybugDB pack that
// @kgpacks/query can read back unchanged: creates the schema, loads Article /
// Section / Chunk / Entity nodes (Section + Chunk carrying FLOAT[768] embeddings),
// materializes HAS_SECTION / HAS_CHUNK / HAS_ENTITY / ENTITY_RELATION edges and the
// read-critical Section→Section LINKS_TO edges, then builds the cosine HNSW vector
// indexes over the loaded embeddings (`embedding_idx`, `chunk_embedding_idx`).
//
// Every statement is issued as a single `run()`; embeddings are bound as plain
// number arrays (`Array.from(Float32Array)`), exactly as the read path expects.

import type { Connection } from '@kgpacks/db';

import { EXTENSIONS, NODE_TABLE_DDL, REL_TABLE_DDL, VECTOR_INDEX_DDL } from './schema.js';
import type { Article, ArticleLink, Chunk, ExtractionResult } from './types.js';

/** One article with its aligned embeddings, chunks, and extracted knowledge. */
export interface LoadableArticle {
  article: Article;
  /** One embedding per `article.sections[i]`, same order. */
  sectionEmbeddings: ReadonlyArray<Float32Array | number[]>;
  chunks: Chunk[];
  /** One embedding per `chunks[i]`, same order. */
  chunkEmbeddings: ReadonlyArray<Float32Array | number[]>;
  extraction: ExtractionResult;
  /**
   * BFS distance from the nearest seed (seed = 0). Persisted on the `Article`
   * node so `/stats` can report the by-depth distribution. Defaults to `0` when
   * the caller does not track expansion (e.g. a flat import).
   */
  expansionDepth?: number;
}

/** The full payload for one {@link loadPack} call. */
export interface LoadPackInput {
  articles: LoadableArticle[];
  /** Article-level links materialized as lead-section → lead-section edges. */
  links: ArticleLink[];
}

/** Outcome counts for a load. */
export interface LoadPackStats {
  articles: number;
  sections: number;
  chunks: number;
  entities: number;
  relationships: number;
  links: number;
  ftsLoaded: boolean;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

function toArray(embedding: Float32Array | number[]): number[] {
  return Array.isArray(embedding) ? embedding : Array.from(embedding);
}

/**
 * Loads required extensions and creates the node/relationship tables. `vector` is
 * mandatory (the read path needs the vector index); `fts` is loaded best-effort so
 * an offline environment without the FTS extension still produces a usable pack.
 * Returns whether FTS was available.
 */
export async function createSchema(conn: Connection): Promise<boolean> {
  let ftsLoaded = false;
  for (const ext of EXTENSIONS) {
    try {
      await conn.loadExtension(ext);
      if (ext === 'fts') {
        ftsLoaded = true;
      }
    } catch (err) {
      if (ext === 'vector') {
        throw err; // vector is required for the read contract
      }
      // FTS is optional; the read path uses title CONTAINS, not an FTS index.
    }
  }
  for (const ddl of NODE_TABLE_DDL) {
    await conn.run(ddl);
  }
  for (const ddl of REL_TABLE_DDL) {
    await conn.run(ddl);
  }
  return ftsLoaded;
}

async function loadArticleNode(
  conn: Connection,
  article: Article,
  expansionDepth: number,
): Promise<void> {
  const totalWords = article.sections.reduce((sum, s) => sum + wordCount(s.content), 0);
  await conn.run(
    'CREATE (:Article {title: $title, category: $category, word_count: $wc, ' +
      'expansion_depth: $depth})',
    {
      title: article.title,
      category: article.category ?? '',
      wc: totalWords,
      depth: expansionDepth,
    },
  );
}

async function loadSections(
  conn: Connection,
  article: Article,
  embeddings: ReadonlyArray<Float32Array | number[]>,
): Promise<void> {
  for (let i = 0; i < article.sections.length; i++) {
    const section = article.sections[i];
    const embedding = embeddings[i];
    if (embedding === undefined) {
      throw new Error(`Missing embedding for section ${section.id}`);
    }
    await conn.run(
      'CREATE (:Section {id: $id, title: $title, content: $content, embedding: $emb, ' +
        'level: $level, word_count: $wc})',
      {
        id: section.id,
        title: section.title,
        content: section.content,
        emb: toArray(embedding),
        level: section.level,
        wc: wordCount(section.content),
      },
    );
    await conn.run(
      'MATCH (a:Article {title: $title}), (s:Section {id: $id}) ' +
        'CREATE (a)-[:HAS_SECTION {section_index: $idx}]->(s)',
      { title: article.title, id: section.id, idx: i },
    );
  }
}

async function loadChunks(
  conn: Connection,
  chunks: Chunk[],
  embeddings: ReadonlyArray<Float32Array | number[]>,
): Promise<void> {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i];
    if (embedding === undefined) {
      throw new Error(`Missing embedding for chunk ${chunk.id}`);
    }
    await conn.run(
      'CREATE (:Chunk {id: $id, content: $content, embedding: $emb, ' +
        'article_title: $at, section_index: $si, chunk_index: $ci})',
      {
        id: chunk.id,
        content: chunk.content,
        emb: toArray(embedding),
        at: chunk.articleTitle,
        si: chunk.sectionIndex,
        ci: chunk.chunkIndex,
      },
    );
    await conn.run(
      'MATCH (a:Article {title: $at}), (c:Chunk {id: $id}) ' +
        'CREATE (a)-[:HAS_CHUNK {section_index: $si, chunk_index: $ci}]->(c)',
      { at: chunk.articleTitle, id: chunk.id, si: chunk.sectionIndex, ci: chunk.chunkIndex },
    );
  }
}

/**
 * Loads entities + their relationships. Entities are deduped across the whole pack
 * by `entity_id` (the trimmed name); `HAS_ENTITY` links the owning article;
 * `ENTITY_RELATION` is created only when both endpoints exist as entities.
 */
async function loadEntities(
  conn: Connection,
  article: Article,
  extraction: ExtractionResult,
  createdEntities: Set<string>,
): Promise<number> {
  let count = 0;
  const localEntityIds = new Set<string>();

  for (const entity of extraction.entities) {
    const entityId = entity.name.trim();
    if (entityId === '') {
      continue;
    }
    if (!createdEntities.has(entityId)) {
      await conn.run(
        'CREATE (:Entity {entity_id: $id, name: $name, type: $type, description: $descr})',
        { id: entityId, name: entity.name, type: entity.type, descr: entity.description ?? '' },
      );
      createdEntities.add(entityId);
      count++;
    }
    if (!localEntityIds.has(entityId)) {
      localEntityIds.add(entityId);
      await conn.run(
        'MATCH (a:Article {title: $title}), (e:Entity {entity_id: $id}) ' +
          'CREATE (a)-[:HAS_ENTITY]->(e)',
        { title: article.title, id: entityId },
      );
    }
  }
  return count;
}

async function loadRelationships(
  conn: Connection,
  extraction: ExtractionResult,
  createdEntities: Set<string>,
): Promise<number> {
  let count = 0;
  for (const rel of extraction.relationships) {
    const source = rel.source.trim();
    const target = rel.target.trim();
    if (!createdEntities.has(source) || !createdEntities.has(target)) {
      continue; // only connect entities that were actually loaded
    }
    await conn.run(
      'MATCH (a:Entity {entity_id: $s}), (b:Entity {entity_id: $t}) ' +
        'CREATE (a)-[:ENTITY_RELATION {relation: $r, context: $c}]->(b)',
      { s: source, t: target, r: rel.relation, c: rel.context ?? '' },
    );
    count++;
  }
  return count;
}

/**
 * Materializes article→article links as `Section`→`Section` edges (lead section to
 * lead section), but only for links whose BOTH endpoint articles were loaded.
 */
async function loadLinks(
  conn: Connection,
  links: ArticleLink[],
  loadedArticles: Set<string>,
): Promise<number> {
  let count = 0;
  const seen = new Set<string>();
  for (const link of links) {
    if (!loadedArticles.has(link.from) || !loadedArticles.has(link.to) || link.from === link.to) {
      continue;
    }
    const fromLead = `${link.from}#0`;
    const toLead = `${link.to}#0`;
    const key = `${fromLead}\u0000${toLead}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    await conn.run(
      'MATCH (a:Section {id: $from}), (b:Section {id: $to}) ' +
        'CREATE (a)-[:LINKS_TO {link_type: $lt}]->(b)',
      { from: fromLead, to: toLead, lt: link.linkType },
    );
    count++;
  }
  return count;
}

/** Builds the cosine HNSW vector indexes over the loaded Section/Chunk embeddings. */
export async function buildVectorIndexes(conn: Connection): Promise<void> {
  for (const ddl of VECTOR_INDEX_DDL) {
    await conn.run(ddl);
  }
}

/**
 * Loads a whole pack into `conn`: schema → nodes/edges → vector indexes. The
 * connection's lifecycle is the caller's responsibility. Returns load counts.
 */
export async function loadPack(conn: Connection, input: LoadPackInput): Promise<LoadPackStats> {
  const ftsLoaded = await createSchema(conn);

  const loadedArticles = new Set<string>();
  const createdEntities = new Set<string>();
  const stats: LoadPackStats = {
    articles: 0,
    sections: 0,
    chunks: 0,
    entities: 0,
    relationships: 0,
    links: 0,
    ftsLoaded,
  };

  for (const item of input.articles) {
    await loadArticleNode(conn, item.article, item.expansionDepth ?? 0);
    await loadSections(conn, item.article, item.sectionEmbeddings);
    await loadChunks(conn, item.chunks, item.chunkEmbeddings);
    stats.entities += await loadEntities(conn, item.article, item.extraction, createdEntities);

    loadedArticles.add(item.article.title);
    stats.articles++;
    stats.sections += item.article.sections.length;
    stats.chunks += item.chunks.length;
  }

  // Relationships + links run after all nodes exist so endpoints resolve.
  for (const item of input.articles) {
    stats.relationships += await loadRelationships(conn, item.extraction, createdEntities);
  }
  stats.links = await loadLinks(conn, input.links, loadedArticles);

  await buildVectorIndexes(conn);
  return stats;
}
