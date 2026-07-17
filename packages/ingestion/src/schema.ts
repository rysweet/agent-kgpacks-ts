// @kgpacks/ingestion — LadybugDB schema (DDL).
//
// Ports the reference schema builder (bootstrap/schema/ryugraph_schema), ADAPTED to the binding read-side
// contract of @kgpacks/query. Two deliberate divergences from the reference:
//   • `Section` carries the read keys the query path returns — `id` (STRING PK),
//     `content`, and `embedding FLOAT[768]` (FLOAT, not DOUBLE — matching the
//     proven query/embeddings vectors) indexed as `embedding_idx` (cosine).
//   • `LINKS_TO` connects `Section`→`Section` (not Article→Article): the query
//     graph reranker traverses `(Section)-[:LINKS_TO]->(Section)` keyed on
//     `Section.id`, so the write side must materialize it at that granularity.
// Everything else mirrors the reference structure (Article/Chunk/Entity nodes and
// the HAS_SECTION/HAS_CHUNK/HAS_ENTITY/ENTITY_RELATION relationships).
//
// Every statement is a single DDL command, issued one-per-`run()` by the loader.

/** Embedding dimensionality (BGE bge-base-en-v1.5 — validated Spike B). */
export const EMBEDDING_DIM = 768;

/** Node table holding the retrieval unit (read contract: `Section`). */
export const SECTION_TABLE = 'Section';
/** Vector index over `Section.embedding` (read contract: `embedding_idx`). */
export const SECTION_VECTOR_INDEX = 'embedding_idx';
/** Node table holding fine-grained chunks. */
export const CHUNK_TABLE = 'Chunk';
/** Vector index over `Chunk.embedding`. */
export const CHUNK_VECTOR_INDEX = 'chunk_embedding_idx';

/** Extensions loaded before any vector/FTS operation. */
export const EXTENSIONS = ['vector', 'fts'] as const;

/** Node-table DDL, in dependency order (nodes before any relationship). */
export const NODE_TABLE_DDL: readonly string[] = [
  `CREATE NODE TABLE Article(
     title STRING,
     category STRING,
     word_count INT64,
     expansion_depth INT64,
     PRIMARY KEY(title)
   )`,
  // `Section` additionally carries structured retrieval keys (cve_id,
  // affected_products, aliases, cpes, purls, ecosystems) populated by the CVE
  // adapter. They are ADDITIVE: vector/hybrid readers select only
  // id/title/content/embedding, so an older reader still opens the pack; the
  // `lexical` retrieve mode reads these columns for exact coordinate matching.
  `CREATE NODE TABLE Section(
     id STRING,
     title STRING,
     content STRING,
     embedding FLOAT[${EMBEDDING_DIM}],
     level INT64,
     word_count INT64,
     cve_id STRING,
     affected_products STRING,
     aliases STRING,
     cpes STRING,
     purls STRING,
     ecosystems STRING,
     PRIMARY KEY(id)
   )`,
  `CREATE NODE TABLE Chunk(
     id STRING,
     content STRING,
     embedding FLOAT[${EMBEDDING_DIM}],
     article_title STRING,
     section_index INT64,
     chunk_index INT64,
     PRIMARY KEY(id)
   )`,
  `CREATE NODE TABLE Entity(
     entity_id STRING,
     name STRING,
     type STRING,
     description STRING,
     PRIMARY KEY(entity_id)
   )`,
  `CREATE NODE TABLE ArticleSource(
     title STRING,
     payload STRING,
     payload_sha256 STRING,
     extractor_version STRING,
     PRIMARY KEY(title)
   )`,
  `CREATE NODE TABLE RelationSupport(
     support_id STRING,
     article_title STRING,
     signature STRING,
     source_entity_id STRING,
     target_entity_id STRING,
     relation STRING,
     context STRING,
     extractor_version STRING,
     PRIMARY KEY(support_id)
   )`,
  `CREATE NODE TABLE UpdateApplication(
     article_title STRING,
     source_payload_sha256 STRING,
     base_payload_sha256 STRING,
     result STRING,
     PRIMARY KEY(article_title)
   )`,
];

/** Relationship-table DDL (created after all node tables exist). */
export const REL_TABLE_DDL: readonly string[] = [
  `CREATE REL TABLE HAS_SECTION(FROM Article TO Section, section_index INT64)`,
  `CREATE REL TABLE HAS_CHUNK(FROM Article TO Chunk, section_index INT64, chunk_index INT64)`,
  `CREATE REL TABLE LINKS_TO(FROM Section TO Section, link_type STRING)`,
  `CREATE REL TABLE HAS_ENTITY(FROM Article TO Entity)`,
  `CREATE REL TABLE ENTITY_RELATION(FROM Entity TO Entity, relation STRING, context STRING)`,
];

/**
 * Vector-index DDL. HNSW indexes are built over existing rows, so these run AFTER
 * the embeddings are loaded (both the reference and query/test create the index
 * post-insert).
 */
export const VECTOR_INDEX_DDL: readonly string[] = [
  `CALL CREATE_VECTOR_INDEX('${SECTION_TABLE}', '${SECTION_VECTOR_INDEX}', 'embedding', metric := 'cosine')`,
  `CALL CREATE_VECTOR_INDEX('${CHUNK_TABLE}', '${CHUNK_VECTOR_INDEX}', 'embedding', metric := 'cosine')`,
];
