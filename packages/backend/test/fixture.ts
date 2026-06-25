// packages/backend/test/fixture.ts
//
// A small, deterministic in-memory LadybugDB fixture for the offline route suites.
// It reuses the proven Spike-A pattern (packages/db): open `Database(':memory:')`,
// load the `vector` extension, create the production `Article` / `Section` /
// `HAS_SECTION` / `LINKS_TO` schema (LINKS_TO is Section→Section, exactly as
// ingestion writes it), seed a handful of articles with hand-chosen 8-dim
// lead-section embeddings, and build the `Section.embedding_idx` cosine index.
//
// Embeddings are arranged so vector-search ordering from the "Quantum entanglement"
// seed is predictable: Bell's theorem (nearest) > EPR paradox > Quantum mechanics,
// with Loop quantum gravity / Photosynthesis effectively orthogonal (similarity ~0).

import { Database } from '@kgpacks/db';

/** Embedding dimension used throughout the fixture and the fake embedder. */
export const EMBED_DIM = 8;

/** Lead-section embedding of "Quantum entanglement" — the fake embedder returns this. */
export const QE_LEAD_VECTOR: number[] = [1, 0, 0, 0, 0, 0, 0, 0];

interface SeedSection {
  title: string;
  content: string;
  wordCount: number;
  level: number;
  embedding: number[];
}

interface SeedArticle {
  title: string;
  category: string;
  wordCount: number;
  expansionDepth: number;
  /** Lead-section (index 0) embedding. */
  lead: number[];
  /** Optional extra sections beyond the lead. */
  extraSections?: SeedSection[];
}

export const SEED_ARTICLES: SeedArticle[] = [
  {
    title: 'Quantum entanglement',
    category: 'Physics',
    wordCount: 5120,
    expansionDepth: 0,
    lead: [1, 0, 0, 0, 0, 0, 0, 0],
    extraSections: [
      {
        title: 'History',
        content: 'The history of quantum entanglement begins with the 1935 EPR paper.',
        wordCount: 100,
        level: 2,
        embedding: [0.95, 0.05, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
  {
    title: "Bell's theorem",
    category: 'Physics',
    wordCount: 4210,
    expansionDepth: 1,
    lead: [0.9, 0.1, 0, 0, 0, 0, 0, 0],
  },
  {
    title: 'EPR paradox',
    category: 'Physics',
    wordCount: 3000,
    expansionDepth: 1,
    lead: [0.8, 0, 0.2, 0, 0, 0, 0, 0],
  },
  {
    title: 'Quantum mechanics',
    category: 'Physics',
    wordCount: 8000,
    expansionDepth: 0,
    lead: [0.7, 0, 0, 0.3, 0, 0, 0, 0],
  },
  {
    title: 'Loop quantum gravity',
    category: 'Physics',
    wordCount: 2200,
    expansionDepth: 2,
    lead: [0, 1, 0, 0, 0, 0, 0, 0],
  },
  {
    title: 'Photosynthesis',
    category: 'Biology',
    wordCount: 1500,
    expansionDepth: 0,
    lead: [0, 0, 0, 0, 0, 0, 0, 1],
  },
];

/** Directed `LINKS_TO` edges (source title → target title). */
export const SEED_LINKS: [string, string][] = [
  ['Quantum entanglement', "Bell's theorem"],
  ['Quantum entanglement', 'EPR paradox'],
  ["Bell's theorem", 'EPR paradox'],
  ['EPR paradox', 'Quantum mechanics'],
  ['Quantum mechanics', 'Quantum entanglement'],
  ['Loop quantum gravity', 'Quantum mechanics'],
];

function leadContent(title: string): string {
  return `${title} is a topic in this knowledge graph. `.repeat(8);
}

/**
 * Builds and returns an in-memory `Database` seeded with the fixture data and a
 * cosine vector index over `Section.embedding`. Close it with `database.close()`.
 */
export async function buildFixtureDatabase(): Promise<Database> {
  const database = new Database();
  const conn = database.connect();
  try {
    await conn.loadExtension('vector');

    await conn.run(
      'CREATE NODE TABLE Article(title STRING, category STRING, word_count INT64, expansion_depth INT64, PRIMARY KEY(title))',
    );
    await conn.run(
      'CREATE NODE TABLE Section(id STRING, title STRING, content STRING, word_count INT64, level INT64, embedding FLOAT[8], PRIMARY KEY(id))',
    );
    await conn.run('CREATE REL TABLE HAS_SECTION(FROM Article TO Section, section_index INT64)');
    await conn.run('CREATE REL TABLE LINKS_TO(FROM Section TO Section, link_type STRING)');

    for (const article of SEED_ARTICLES) {
      await conn.run(
        'CREATE (:Article {title: $title, category: $category, word_count: $wc, expansion_depth: $depth})',
        {
          title: article.title,
          category: article.category,
          wc: article.wordCount,
          depth: article.expansionDepth,
        },
      );

      const leadId = `${article.title}#0`;
      await conn.run(
        'CREATE (:Section {id: $id, title: $title, content: $content, word_count: $wc, level: $level, embedding: $emb})',
        {
          id: leadId,
          title: 'Introduction',
          content: leadContent(article.title),
          wc: 320,
          level: 1,
          emb: article.lead,
        },
      );
      await conn.run(
        'MATCH (a:Article {title: $t}), (s:Section {id: $sid}) CREATE (a)-[:HAS_SECTION {section_index: 0}]->(s)',
        { t: article.title, sid: leadId },
      );

      let index = 1;
      for (const section of article.extraSections ?? []) {
        const sectionId = `${article.title}#${index}`;
        await conn.run(
          'CREATE (:Section {id: $id, title: $title, content: $content, word_count: $wc, level: $level, embedding: $emb})',
          {
            id: sectionId,
            title: section.title,
            content: section.content,
            wc: section.wordCount,
            level: section.level,
            emb: section.embedding,
          },
        );
        await conn.run(
          'MATCH (a:Article {title: $t}), (s:Section {id: $sid}) CREATE (a)-[:HAS_SECTION {section_index: $idx}]->(s)',
          { t: article.title, sid: sectionId, idx: index },
        );
        index += 1;
      }
    }

    // Article links are materialized as lead-section→lead-section `LINKS_TO`
    // edges, exactly as ingestion/loader.ts writes them in a real pack.
    for (const [source, target] of SEED_LINKS) {
      await conn.run(
        'MATCH (a:Section {id: $s}), (b:Section {id: $t}) ' +
          "CREATE (a)-[:LINKS_TO {link_type: 'wiki'}]->(b)",
        { s: `${source}#0`, t: `${target}#0` },
      );
    }

    await conn.run(
      `CALL CREATE_VECTOR_INDEX('Section', 'embedding_idx', 'embedding', metric := 'cosine')`,
    );
  } finally {
    conn.close();
  }
  return database;
}
