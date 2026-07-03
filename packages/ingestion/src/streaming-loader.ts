// @kgpacks/ingestion — streaming, bulk LadybugDB loader.
//
// `loadPack` is correct but loads the whole pack at once via one `CREATE` per node
// and edge — fine for article packs, but at corpus scale (100k+ records) it both
// holds every embedding in memory and issues millions of sequential statements.
//
// `createPackWriter` produces the SAME on-disk pack (identical schema, nodes, edges
// and vector indexes — `@kgpacks/query` reads it back unchanged) but:
//   • streams: the caller feeds batches and discards each one, so peak memory is a
//     single batch of embeddings rather than the whole corpus;
//   • bulk-inserts: every node/edge batch is one `UNWIND $rows ...` prepared
//     statement, cutting the per-row round-trips that dominate large loads.
//
// Semantics mirror `loadPack` exactly: entities dedupe globally by `entity_id`;
// `HAS_ENTITY` links the owning article; `ENTITY_RELATION` / `LINKS_TO` are
// materialized in `finalize()` (a second pass) so only edges whose BOTH endpoints
// were loaded survive; vector indexes are built once at the end.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Connection } from '@kgpacks/db';

import { buildVectorIndexes, createSchema, type LoadableArticle } from './loader.js';
import type { ArticleLink, Relationship } from './types.js';

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/** RFC4180 CSV field: quote and double any embedded quotes. */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

interface RelRow {
  s: string;
  t: string;
  rel: string;
  ctx: string;
}

/**
 * Bulk-creates ENTITY_RELATION (Entity→Entity) edges scalably. Prefers LadybugDB's
 * `COPY <Rel> FROM <csv>` — a single bulk import that scales to the full corpus —
 * and falls back to PK-indexed `UNWIND ... MATCH ... CREATE` batches if COPY is
 * unavailable or rejects the file. BOTH shapes are non-O(N^2): neither uses a comma
 * two-pattern `MATCH` over the growing node tables. Returns the number created.
 */
async function bulkCreateEntityRelations(conn: Connection, relRows: RelRow[]): Promise<number> {
  if (relRows.length === 0) return 0;
  const dir = mkdtempSync(join(tmpdir(), 'kgpacks-rels-'));
  const file = join(dir, 'entity_relation.csv');
  try {
    // Columns: FROM pk, TO pk, then rel properties in declaration order
    // (relation, context) — the order LadybugDB's REL COPY expects.
    const csv = relRows
      .map((r) => `${csvField(r.s)},${csvField(r.t)},${csvField(r.rel)},${csvField(r.ctx)}`)
      .join('\n');
    writeFileSync(file, `${csv}\n`);
    await conn.run(`COPY ENTITY_RELATION FROM "${file.replace(/\\/g, '/')}"`);
    return relRows.length;
  } catch {
    // COPY unsupported/rejected → PK-indexed UNWIND fallback (still ~linear).
    let created = 0;
    await inChunks(relRows, RELATION_FALLBACK_CHUNK, async (rows) => {
      await conn.run(
        'UNWIND $rows AS r MATCH (a:Entity {entity_id: r.s}) MATCH (b:Entity {entity_id: r.t}) ' +
          'CREATE (a)-[:ENTITY_RELATION {relation: r.rel, context: r.ctx}]->(b)',
        { rows },
      );
      created += rows.length;
    });
    return created;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RELATION_FALLBACK_CHUNK = 1000;

function toArray(embedding: Float32Array | number[]): number[] {
  return Array.isArray(embedding) ? embedding : Array.from(embedding);
}

/** Outcome counts for a streaming load (matches `LoadPackStats`). */
export interface PackWriterStats {
  articles: number;
  sections: number;
  chunks: number;
  entities: number;
  relationships: number;
  links: number;
  ftsLoaded: boolean;
}

/** Incremental pack writer: feed batches with {@link PackWriter.addBatch}, then {@link PackWriter.finalize}. */
export interface PackWriter {
  /** Bulk-loads one batch of articles (nodes + HAS_* edges); relationships are deferred. */
  addBatch(items: LoadableArticle[]): Promise<void>;
  /** Materializes deferred entity relations + the given links, builds vector indexes, returns counts. */
  finalize(links?: ArticleLink[]): Promise<PackWriterStats>;
}

export interface PackWriterOptions {
  /** Max rows per `UNWIND` statement (bounds prepared-statement param size). Default 500. */
  insertChunkSize?: number;
  /**
   * Skip building `ENTITY_RELATION` (Entity→Entity) edges in {@link PackWriter.finalize}.
   *
   * No read path (`@kgpacks/query` retrieval/reranker, the backend graph route,
   * the MCP server) traverses `ENTITY_RELATION` — retrieval uses vector search +
   * single-hop `LINKS_TO`. Building these edges is pure write-side overhead and is
   * super-linear at scale (high-degree shared entities), dominating finalize on
   * large structured corpora (e.g. CVE: ~3h of a ~4h finalize). Set this to skip
   * them: `stats.relationships` stays 0 and nothing else changes. Default `false`
   * (build them) for backward compatibility.
   */
  skipEntityRelations?: boolean;
}

/** Splits `rows` into `size`-bounded slices and runs `fn` on each in order. */
async function inChunks<T>(
  rows: T[],
  size: number,
  fn: (slice: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await fn(rows.slice(i, i + size));
  }
}

/**
 * Opens a streaming bulk writer over `conn`. Runs {@link createSchema} immediately;
 * the connection's lifecycle remains the caller's responsibility.
 */
export async function createPackWriter(
  conn: Connection,
  options: PackWriterOptions = {},
): Promise<PackWriter> {
  const chunkSize = options.insertChunkSize ?? 500;
  const skipEntityRelations = options.skipEntityRelations ?? false;
  const ftsLoaded = await createSchema(conn);

  const createdEntities = new Set<string>();
  const loadedArticles = new Set<string>();
  const pendingRelationships: Relationship[] = [];
  const stats: PackWriterStats = {
    articles: 0,
    sections: 0,
    chunks: 0,
    entities: 0,
    relationships: 0,
    links: 0,
    ftsLoaded,
  };

  async function addBatch(items: LoadableArticle[]): Promise<void> {
    if (items.length === 0) return;

    const articleRows: { title: string; category: string; wc: number; depth: number }[] = [];
    // Section/Chunk rows carry their parent Article title (`at`) so the edge is
    // co-created with the node via a single PK-indexed MATCH of the Article (see
    // the CREATE statements below) — avoiding a two-pattern MATCH that hash-joins
    // two growing node tables and makes the load O(N²).
    const sectionRows: {
      at: string;
      id: string;
      title: string;
      content: string;
      emb: number[];
      level: number;
      wc: number;
      idx: number;
    }[] = [];
    const chunkRows: {
      id: string;
      content: string;
      emb: number[];
      at: string;
      si: number;
      ci: number;
    }[] = [];
    const entityRows: { id: string; name: string; type: string; descr: string }[] = [];
    const hasEntityRows: { at: string; eid: string }[] = [];

    for (const item of items) {
      const { article } = item;
      const totalWords = article.sections.reduce((s, sec) => s + wordCount(sec.content), 0);
      articleRows.push({
        title: article.title,
        category: article.category ?? '',
        wc: totalWords,
        // Streaming/flat imports (e.g. CVE) are not BFS-expanded; every article is a
        // depth-0 seed. Persisting 0 (not NULL) keeps the schema identical to
        // loadPack so /stats by_depth works on streaming-built packs too.
        depth: item.expansionDepth ?? 0,
      });

      for (let i = 0; i < article.sections.length; i++) {
        const section = article.sections[i];
        const embedding = item.sectionEmbeddings[i];
        if (embedding === undefined) throw new Error(`Missing embedding for section ${section.id}`);
        sectionRows.push({
          at: article.title,
          id: section.id,
          title: section.title,
          content: section.content,
          emb: toArray(embedding),
          level: section.level,
          wc: wordCount(section.content),
          idx: i,
        });
      }

      for (let i = 0; i < item.chunks.length; i++) {
        const chunk = item.chunks[i];
        const embedding = item.chunkEmbeddings[i];
        if (embedding === undefined) throw new Error(`Missing embedding for chunk ${chunk.id}`);
        chunkRows.push({
          id: chunk.id,
          content: chunk.content,
          emb: toArray(embedding),
          at: chunk.articleTitle,
          si: chunk.sectionIndex,
          ci: chunk.chunkIndex,
        });
      }

      const localEntityIds = new Set<string>();
      for (const entity of item.extraction.entities) {
        const entityId = entity.name.trim();
        if (entityId === '') continue;
        if (!createdEntities.has(entityId)) {
          createdEntities.add(entityId);
          entityRows.push({
            id: entityId,
            name: entity.name,
            type: entity.type,
            descr: entity.description ?? '',
          });
          stats.entities++;
        }
        if (!localEntityIds.has(entityId)) {
          localEntityIds.add(entityId);
          hasEntityRows.push({ at: article.title, eid: entityId });
        }
      }
      if (!skipEntityRelations) {
        for (const rel of item.extraction.relationships) pendingRelationships.push(rel);
      }

      loadedArticles.add(article.title);
      stats.articles++;
      stats.sections += article.sections.length;
      stats.chunks += item.chunks.length;
    }

    await inChunks(articleRows, chunkSize, (rows) =>
      conn.run(
        'UNWIND $rows AS r CREATE (:Article {title: r.title, category: r.category, ' +
          'word_count: r.wc, expansion_depth: r.depth})',
        { rows },
      ),
    );
    // Co-create each Section and its HAS_SECTION edge from a single PK-indexed
    // MATCH of the (already-created) parent Article. A two-pattern MATCH of both
    // Article AND Section hash-joins two growing tables → O(N²); this point-looks
    // up only the Article and creates the new Section inline → flat per batch.
    await inChunks(sectionRows, chunkSize, (rows) =>
      conn.run(
        'UNWIND $rows AS r MATCH (a:Article {title: r.at}) ' +
          'CREATE (a)-[:HAS_SECTION {section_index: r.idx}]->(:Section {id: r.id, ' +
          'title: r.title, content: r.content, embedding: r.emb, level: r.level, word_count: r.wc})',
        { rows },
      ),
    );
    await inChunks(chunkRows, chunkSize, (rows) =>
      conn.run(
        'UNWIND $rows AS r MATCH (a:Article {title: r.at}) ' +
          'CREATE (a)-[:HAS_CHUNK {section_index: r.si, chunk_index: r.ci}]->(:Chunk {id: r.id, ' +
          'content: r.content, embedding: r.emb, article_title: r.at, section_index: r.si, chunk_index: r.ci})',
        { rows },
      ),
    );
    await inChunks(entityRows, chunkSize, (rows) =>
      conn.run(
        'UNWIND $rows AS r CREATE (:Entity {entity_id: r.id, name: r.name, type: r.type, description: r.descr})',
        { rows },
      ),
    );
    // Entities are shared (deduped globally), so the edge connects two pre-existing
    // nodes. Use SEPARATE MATCH clauses (two PK point-lookups) rather than a
    // comma two-pattern MATCH (which hash-joins the growing Article+Entity tables).
    await inChunks(hasEntityRows, chunkSize, (rows) =>
      conn.run(
        'UNWIND $rows AS r MATCH (a:Article {title: r.at}) MATCH (e:Entity {entity_id: r.eid}) ' +
          'CREATE (a)-[:HAS_ENTITY]->(e)',
        { rows },
      ),
    );
  }

  async function finalize(links: ArticleLink[] = []): Promise<PackWriterStats> {
    if (!skipEntityRelations) {
      const relRows = pendingRelationships
        .map((rel) => ({
          s: rel.source.trim(),
          t: rel.target.trim(),
          rel: rel.relation,
          ctx: rel.context ?? '',
        }))
        .filter((r) => createdEntities.has(r.s) && createdEntities.has(r.t));
      stats.relationships += await bulkCreateEntityRelations(conn, relRows);
    }

    const seen = new Set<string>();
    const linkRows: { from: string; to: string; lt: string }[] = [];
    for (const link of links) {
      if (!loadedArticles.has(link.from) || !loadedArticles.has(link.to) || link.from === link.to)
        continue;
      const from = `${link.from}#0`;
      const to = `${link.to}#0`;
      const key = `${from}\u0000${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      linkRows.push({ from, to, lt: link.linkType });
    }
    await inChunks(linkRows, chunkSize, async (rows) => {
      await conn.run(
        'UNWIND $rows AS r MATCH (a:Section {id: r.from}) MATCH (b:Section {id: r.to}) ' +
          'CREATE (a)-[:LINKS_TO {link_type: r.lt}]->(b)',
        { rows },
      );
      stats.links += rows.length;
    });

    await buildVectorIndexes(conn);
    return stats;
  }

  return { addBatch, finalize };
}
