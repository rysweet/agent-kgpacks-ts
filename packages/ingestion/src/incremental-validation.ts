import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Database, type Connection } from '@kgpacks/db';
import { isValidSemver, loadManifestFromDir } from '@kgpacks/packs';

import { chunkArticle } from './chunking.js';
import { CVE_ADAPTER_VERSION, CVE_ID_RE, cveToGraph } from './cve-adapter.js';
import { KnowledgePackValidationError } from './errors.js';
import { fileEntry } from './incremental-files.js';
import {
  createManifest,
  databaseCounts,
  groupByArticle,
  isFiniteEmbedding,
  asNumberArray,
  readPackMetadata,
  readUpdateApplications,
} from './incremental-pack.js';
import {
  INCREMENTAL_SCHEMA_VERSION,
  SHA256_RE,
  UPDATE_TOOL_VERSION,
  canonical,
  contentDigest,
  hasCanonicalProvenance,
  provenanceEmbeddingModel,
  sha256,
  type PackValidationResult,
} from './incremental-shared.js';

async function validateVectorIndexMembership(
  connection: Connection,
  table: 'Section' | 'Chunk',
  index: string,
  expected: number,
): Promise<void> {
  let afterId = '';
  let validated = 0;
  let queryVector: number[] | undefined;
  while (true) {
    const rows = await connection.run<{ id: string; embedding: unknown }>(
      `MATCH (node:${table}) WHERE node.id > $afterId ` +
        'RETURN node.id AS id, node.embedding AS embedding ORDER BY id LIMIT 256',
      { afterId },
    );
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    for (const row of rows) {
      if (!isFiniteEmbedding(row.embedding)) {
        throw new Error(`${index} membership does not match live ${table} rows`);
      }
      queryVector ??= asNumberArray(row.embedding);
      validated++;
    }
  }
  if (validated !== expected || (expected > 0 && queryVector === undefined)) {
    throw new Error(`${index} membership does not match live ${table} rows`);
  }
  if (expected === 0) return;

  // The index definition covers the complete fixed-width property. Keep the
  // operability probe bounded after validating every live vector above.
  const probeSize = Math.min(expected, 32);
  const probe = await connection.run<{
    hits: number | bigint;
    uniqueCount: number | bigint;
    liveCount: number | bigint;
  }>(
    `CALL QUERY_VECTOR_INDEX('${table}', '${index}', $queryVector, $requested) ` +
      `OPTIONAL MATCH (live:${table} {id: node.id}) ` +
      'RETURN count(*) AS hits, count(DISTINCT node.id) AS uniqueCount, ' +
      'count(live) AS liveCount',
    { queryVector, requested: probeSize },
  );
  const hits = Number(probe[0]?.hits ?? 0);
  if (
    hits === 0 ||
    hits > probeSize ||
    Number(probe[0]?.uniqueCount ?? 0) !== hits ||
    Number(probe[0]?.liveCount ?? 0) !== hits
  ) {
    throw new Error(`${index} membership does not match live ${table} rows`);
  }
}

/** Comprehensively validates an update-capable pack and its generated indexes. */
async function validateKnowledgePackInternal(packDir: string): Promise<PackValidationResult> {
  const dir = resolve(packDir);
  if (!lstatSync(dir).isDirectory()) throw new Error(`pack path is not a directory: ${dir}`);
  for (const name of ['manifest.json', 'pack.db']) {
    if (!lstatSync(join(dir, name)).isFile()) {
      throw new Error(`pack payload must be a regular file: ${name}`);
    }
  }
  const manifest = loadManifestFromDir(dir);
  if (
    manifest.schemaVersion !== INCREMENTAL_SCHEMA_VERSION ||
    typeof manifest.packId !== 'string' ||
    manifest.packId !== manifest.name ||
    manifest.adapterVersion !== CVE_ADAPTER_VERSION ||
    manifest.extractorVersion !== CVE_ADAPTER_VERSION ||
    manifest.toolVersion !== UPDATE_TOOL_VERSION ||
    typeof manifest.buildId !== 'string' ||
    !SHA256_RE.test(manifest.buildId) ||
    typeof manifest.contentDigest !== 'string' ||
    !SHA256_RE.test(manifest.contentDigest)
  ) {
    throw new Error('manifest identity or schema version is invalid');
  }
  const listed = manifest.files;
  if (
    !Array.isArray(listed) ||
    listed.length !== 1 ||
    !listed[0] ||
    typeof listed[0] !== 'object' ||
    (listed[0] as Record<string, unknown>).path !== 'pack.db'
  ) {
    throw new Error('manifest payload list must contain only pack.db');
  }
  const expectedFiles = new Set(['manifest.json']);
  const actualFileEntries: Array<{ path: string; size: number; sha256: string }> = [];
  for (const entry of listed) {
    if (!entry || typeof entry !== 'object') throw new Error('manifest contains an invalid file');
    const file = entry as Record<string, unknown>;
    const relative = String(file.path);
    expectedFiles.add(relative);
    const actual = await fileEntry(join(dir, relative), relative);
    actualFileEntries.push(actual);
    if (actual.size !== file.size || actual.sha256 !== file.sha256) {
      throw new Error(`payload checksum mismatch: ${relative}`);
    }
  }
  const actualFiles = readdirSync(dir).sort();
  const unlisted = actualFiles.filter((name) => !expectedFiles.has(name));
  if (unlisted.length) throw new Error(`unlisted payload files: ${unlisted.join(', ')}`);
  const actualContentDigest = contentDigest(actualFileEntries);
  if (actualContentDigest !== manifest.contentDigest) {
    throw new Error('manifest content digest mismatch');
  }

  const database = new Database(join(dir, 'pack.db'), { readOnly: true });
  const connection = database.connect();
  try {
    await connection.loadExtension('vector');
    const tables = await connection.run<{ name: string; type: string }>(
      'CALL SHOW_TABLES() RETURN name, type ORDER BY type, name',
    );
    const expectedTables = [
      ['Article', 'NODE'],
      ['ArticleSource', 'NODE'],
      ['Chunk', 'NODE'],
      ['Entity', 'NODE'],
      ['PackMetadata', 'NODE'],
      ['RelationSupport', 'NODE'],
      ['Section', 'NODE'],
      ['UpdateApplication', 'NODE'],
      ['ENTITY_RELATION', 'REL'],
      ['HAS_CHUNK', 'REL'],
      ['HAS_ENTITY', 'REL'],
      ['HAS_SECTION', 'REL'],
      ['LINKS_TO', 'REL'],
    ].map(([name, type]) => ({ name, type }));
    if (canonical(tables) !== canonical(expectedTables)) {
      throw new Error('pack database schema contains missing or unsupported tables');
    }
    const metadata = await readPackMetadata(connection);
    const applications = await readUpdateApplications(connection);
    const embeddingModel = provenanceEmbeddingModel(metadata.provenance);
    if (
      metadata.packId === '' ||
      !isValidSemver(metadata.version) ||
      metadata.schemaVersion !== INCREMENTAL_SCHEMA_VERSION ||
      metadata.adapterVersion !== CVE_ADAPTER_VERSION ||
      metadata.extractorVersion !== CVE_ADAPTER_VERSION ||
      metadata.toolVersion !== UPDATE_TOOL_VERSION ||
      !SHA256_RE.test(metadata.buildId) ||
      embeddingModel === null ||
      !hasCanonicalProvenance(metadata.provenance, embeddingModel)
    ) {
      throw new Error('pack database metadata identity or provenance is invalid');
    }
    const baseFields = [
      metadata.basePackId,
      metadata.baseVersion,
      metadata.baseBuildId,
      metadata.baseContentDigest,
    ];
    const deltaFields = [metadata.deltaId, metadata.deltaFileSha256];
    const incremental = baseFields.every((value) => value !== null);
    if (
      (!incremental && baseFields.some((value) => value !== null)) ||
      deltaFields.some((value) => (incremental ? value === null : value !== null)) ||
      (incremental &&
        (metadata.basePackId !== metadata.packId ||
          metadata.baseVersion === metadata.version ||
          !SHA256_RE.test(metadata.baseBuildId ?? '') ||
          !SHA256_RE.test(metadata.baseContentDigest ?? '') ||
          !SHA256_RE.test(metadata.deltaFileSha256 ?? '')))
    ) {
      throw new Error('pack database metadata lineage is invalid');
    }
    const applicationKeys = new Set<string>();
    for (const application of applications) {
      if (
        !incremental ||
        applicationKeys.has(application.key) ||
        !CVE_ID_RE.test(application.key) ||
        application.operation !== 'upsert' ||
        !SHA256_RE.test(application.resultPayloadSha256) ||
        (application.basePayloadSha256 !== null &&
          !SHA256_RE.test(application.basePayloadSha256)) ||
        (application.classification === 'added' && application.basePayloadSha256 !== null) ||
        (application.classification === 'modified' &&
          (application.basePayloadSha256 === null ||
            application.basePayloadSha256 === application.resultPayloadSha256)) ||
        (application.classification === 'unchanged' &&
          application.basePayloadSha256 !== application.resultPayloadSha256) ||
        !['added', 'modified', 'unchanged'].includes(application.classification)
      ) {
        throw new Error('pack database delta application evidence is invalid');
      }
      applicationKeys.add(application.key);
    }
    const expectedDeltaId = sha256(
      canonical(
        applications.map((application) => ({
          operation: 'upsert',
          key: application.key,
          sourcePayloadSha256: application.resultPayloadSha256,
        })),
      ),
    );
    if (
      (incremental && metadata.deltaId !== expectedDeltaId) ||
      (!incremental && applications.length !== 0)
    ) {
      throw new Error('pack database delta application evidence does not match delta identity');
    }
    const expectedBuildId = sha256(
      canonical({
        packId: metadata.packId,
        version: metadata.version,
        baseContentDigest: metadata.baseContentDigest,
        deltaId: metadata.deltaId,
        schemaVersion: metadata.schemaVersion,
        adapterVersion: metadata.adapterVersion,
        extractorVersion: metadata.extractorVersion,
        toolVersion: metadata.toolVersion,
        embeddingModel,
      }),
    );
    if (expectedBuildId !== metadata.buildId) {
      throw new Error('pack database build ID does not match canonical durable inputs');
    }
    const indexes = await connection.run<{
      tableName: string;
      indexName: string;
      indexType: string;
      propertyNames: string[];
      definition: string;
    }>(
      'CALL SHOW_INDEXES() RETURN table_name AS tableName, index_name AS indexName, ' +
        'index_type AS indexType, property_names AS propertyNames, ' +
        'index_definition AS definition ORDER BY tableName, indexName',
    );
    const expectedIndexes = [
      { tableName: 'Chunk', indexName: 'chunk_embedding_idx' },
      { tableName: 'Section', indexName: 'embedding_idx' },
    ];
    if (
      indexes.length !== expectedIndexes.length ||
      indexes.some((index, position) => {
        const expected = expectedIndexes[position];
        return (
          index.tableName !== expected.tableName ||
          index.indexName !== expected.indexName ||
          index.indexType !== 'HNSW' ||
          canonical(index.propertyNames) !== canonical(['embedding']) ||
          !index.definition.includes("metric := 'cosine'")
        );
      })
    ) {
      throw new Error('pack vector index definitions do not match the required schema');
    }
    const counts = await databaseCounts(connection);
    const linkRows = await connection.run<{ count: number | bigint }>(
      'MATCH ()-[r:LINKS_TO]->() RETURN count(r) AS count',
    );
    if (Number(linkRows[0]?.count ?? 0) !== 0) {
      throw new Error('CVE pack LINKS_TO closure must be empty');
    }
    const expectedManifest = createManifest({
      metadata,
      applications,
      files: actualFileEntries,
      counts,
    });
    if (canonical(manifest) !== canonical(expectedManifest)) {
      throw new Error('manifest projection does not match authoritative database and filesystem');
    }
    const applicationSourceHashes = new Map(
      applications.map((application) => [application.key, application.resultPayloadSha256]),
    );
    let afterTitle = '';
    let processedArticles = 0;
    let processedSections = 0;
    let processedChunks = 0;
    let processedEntitySupport = 0;
    let processedRelationSupport = 0;
    const seenEntityIds = new Set<string>();
    const validationBatchSize = 256;
    while (true) {
      const sources = await connection.run<{
        title: string;
        payload: string;
        hash: string;
        version: string;
      }>(
        'MATCH (s:ArticleSource) WHERE s.title > $afterTitle ' +
          'RETURN s.title AS title, s.payload AS payload, s.payload_sha256 AS hash, ' +
          's.extractor_version AS version ORDER BY title LIMIT 256',
        { afterTitle },
      );
      if (sources.length === 0) break;
      if (sources.length > validationBatchSize) {
        throw new Error('article source validation batch exceeded its configured bound');
      }
      afterTitle = sources[sources.length - 1].title;
      const titles = sources.map((source) => source.title);
      const articles = await connection.run<{
        title: string;
        category: string;
        wordCount: number | bigint;
      }>(
        'MATCH (a:Article) WHERE a.title IN $titles RETURN a.title AS title, ' +
          'a.category AS category, a.word_count AS wordCount ORDER BY title',
        { titles },
      );
      if (canonical(articles.map((article) => article.title)) !== canonical(titles)) {
        throw new Error('article source provenance is incomplete');
      }
      const sections = await connection.run<Record<string, unknown>>(
        'MATCH (a:Article)-[r:HAS_SECTION]->(s:Section) WHERE a.title IN $titles ' +
          'RETURN a.title AS article, r.section_index AS idx, s.id AS id, s.title AS title, ' +
          's.content AS content, s.level AS level, s.cve_id AS cveId, ' +
          's.affected_products AS affectedProducts, s.aliases AS aliases, s.cpes AS cpes, ' +
          's.purls AS purls, s.ecosystems AS ecosystems ORDER BY article, idx',
        { titles },
      );
      const chunks = await connection.run<Record<string, unknown>>(
        'MATCH (a:Article)-[r:HAS_CHUNK]->(c:Chunk) WHERE a.title IN $titles ' +
          'RETURN a.title AS article, r.section_index AS edgeSectionIndex, ' +
          'r.chunk_index AS edgeChunkIndex, c.id AS id, c.content AS content, ' +
          'c.article_title AS articleTitle, c.section_index AS sectionIndex, ' +
          'c.chunk_index AS chunkIndex ORDER BY article, edgeSectionIndex, edgeChunkIndex',
        { titles },
      );
      const entitySupport = await connection.run<{
        article: string;
        entity: string;
        name: string;
        type: string;
        description: string;
      }>(
        'MATCH (a:Article)-[:HAS_ENTITY]->(e:Entity) WHERE a.title IN $titles ' +
          'RETURN a.title AS article, e.entity_id AS entity, e.name AS name, e.type AS type, ' +
          'e.description AS description ORDER BY article, entity',
        { titles },
      );
      const relationSupport = await connection.run<{
        article: string;
        signature: string;
        version: string;
      }>(
        'MATCH (p:RelationSupport) WHERE p.article_title IN $titles ' +
          'RETURN p.article_title AS article, p.signature AS signature, ' +
          'p.extractor_version AS version ORDER BY article, signature',
        { titles },
      );
      if (relationSupport.some((support) => support.version !== CVE_ADAPTER_VERSION)) {
        throw new Error('relation provenance has an incompatible extractor version');
      }
      processedArticles += sources.length;
      processedSections += sections.length;
      processedChunks += chunks.length;
      processedEntitySupport += entitySupport.length;
      processedRelationSupport += relationSupport.length;
      const articleByTitle = new Map(articles.map((article) => [article.title, article]));
      const sectionsByArticle = groupByArticle(sections);
      const chunksByArticle = groupByArticle(chunks);
      const entitySupportByArticle = groupByArticle(
        entitySupport as unknown as Array<Record<string, unknown>>,
      );
      const relationSupportByArticle = groupByArticle(
        relationSupport as unknown as Array<Record<string, unknown>>,
      );
      for (const source of sources) {
        if (sha256(source.payload) !== source.hash) {
          throw new Error(`article source hash mismatch: ${source.title}`);
        }
        if (source.version !== CVE_ADAPTER_VERSION) {
          throw new Error(`article extractor version mismatch: ${source.title}`);
        }
        const expectedApplicationHash = applicationSourceHashes.get(source.title);
        if (expectedApplicationHash !== undefined) {
          if (expectedApplicationHash !== source.hash) {
            throw new Error(
              'durable delta application evidence does not match final article sources',
            );
          }
          applicationSourceHashes.delete(source.title);
        }
        const graph = cveToGraph(JSON.parse(source.payload));
        if (!graph || graph.article.title !== source.title) {
          throw new Error(`article source adapter mismatch: ${source.title}`);
        }
        const article = articleByTitle.get(source.title);
        const expectedWordCount = graph.article.sections.reduce((sum, section) => {
          const content = section.content.trim();
          return sum + (content === '' ? 0 : content.split(/\s+/).length);
        }, 0);
        if (
          !article ||
          article.category !== (graph.article.category ?? '') ||
          Number(article.wordCount) !== expectedWordCount
        ) {
          throw new Error(`article data does not match extractor output: ${source.title}`);
        }
        const expectedSections = graph.article.sections.map((section, idx) => ({
          idx,
          id: section.id,
          title: section.title,
          content: section.content,
          level: section.level,
          cveId: section.cveId ?? '',
          affectedProducts: section.affectedProducts ?? '',
          aliases: section.aliases ?? '',
          cpes: section.cpes ?? '',
          purls: section.purls ?? '',
          ecosystems: section.ecosystems ?? '',
        }));
        const actualSections = (sectionsByArticle.get(source.title) ?? []).map((section) => ({
          idx: Number(section.idx),
          id: String(section.id),
          title: String(section.title),
          content: String(section.content),
          level: Number(section.level),
          cveId: String(section.cveId),
          affectedProducts: String(section.affectedProducts),
          aliases: String(section.aliases),
          cpes: String(section.cpes),
          purls: String(section.purls),
          ecosystems: String(section.ecosystems),
        }));
        if (canonical(actualSections) !== canonical(expectedSections)) {
          throw new Error(`section data does not match extractor output: ${source.title}`);
        }
        const expectedChunks = chunkArticle(graph.article, { size: 4000, overlap: 0 }).map(
          (chunk) => ({
            id: chunk.id,
            content: chunk.content,
            articleTitle: chunk.articleTitle,
            sectionIndex: chunk.sectionIndex,
            chunkIndex: chunk.chunkIndex,
            edgeSectionIndex: chunk.sectionIndex,
            edgeChunkIndex: chunk.chunkIndex,
          }),
        );
        const actualChunks = (chunksByArticle.get(source.title) ?? []).map((chunk) => ({
          id: String(chunk.id),
          content: String(chunk.content),
          articleTitle: String(chunk.articleTitle),
          sectionIndex: Number(chunk.sectionIndex),
          chunkIndex: Number(chunk.chunkIndex),
          edgeSectionIndex: Number(chunk.edgeSectionIndex),
          edgeChunkIndex: Number(chunk.edgeChunkIndex),
        }));
        if (canonical(actualChunks) !== canonical(expectedChunks)) {
          throw new Error(`chunk data does not match extractor output: ${source.title}`);
        }
        const expectedEntities = [
          ...new Set(
            graph.extraction.entities
              .map((entity) => entity.name.trim())
              .filter((entity) => entity !== ''),
          ),
        ].sort();
        const actualEntityRows = entitySupportByArticle.get(source.title) ?? [];
        const actualEntities = actualEntityRows.map((support) => String(support.entity)).sort();
        if (canonical(expectedEntities) !== canonical(actualEntities)) {
          throw new Error(`entity provenance does not match extractor output: ${source.title}`);
        }
        const actualEntityById = new Map(
          actualEntityRows.map((support) => [String(support.entity), support]),
        );
        for (const entity of graph.extraction.entities) {
          const id = entity.name.trim();
          if (id === '' || seenEntityIds.has(id)) continue;
          const actual = actualEntityById.get(id);
          if (
            !actual ||
            String(actual.name) !== entity.name ||
            String(actual.type) !== entity.type ||
            String(actual.description) !== (entity.description ?? '')
          ) {
            throw new Error('entity data does not match deterministic extractor output');
          }
          seenEntityIds.add(id);
        }
        const expectedRelations = [
          ...new Set(
            graph.extraction.relationships.map((relationship) =>
              JSON.stringify([
                relationship.source.trim(),
                relationship.relation,
                relationship.target.trim(),
                relationship.context ?? '',
              ]),
            ),
          ),
        ].sort();
        const actualRelations = (relationSupportByArticle.get(source.title) ?? [])
          .map((support) => String(support.signature))
          .sort();
        if (canonical(expectedRelations) !== canonical(actualRelations)) {
          throw new Error(`relation provenance does not match extractor output: ${source.title}`);
        }
      }
    }
    if (
      processedArticles !== counts.articles ||
      processedSections !== counts.sections ||
      processedChunks !== counts.chunks ||
      processedEntitySupport !== counts.entitySupport ||
      processedRelationSupport !== counts.relationSupport
    ) {
      throw new Error('article graph ownership or provenance counts are incomplete');
    }
    if (seenEntityIds.size !== counts.entities) {
      throw new Error('entity data does not match deterministic extractor output');
    }
    if (applicationSourceHashes.size > 0) {
      throw new Error('durable delta application evidence does not match final article sources');
    }
    const orphanSupport = await connection.run(
      'MATCH (p:RelationSupport) WHERE NOT EXISTS { MATCH (a:Article) WHERE a.title = p.article_title } ' +
        'OR NOT EXISTS { MATCH (s:Entity) WHERE s.entity_id = p.source_entity_id } ' +
        'OR NOT EXISTS { MATCH (t:Entity) WHERE t.entity_id = p.target_entity_id } ' +
        'RETURN p.support_id AS id LIMIT 1',
    );
    if (orphanSupport.length) throw new Error('relation provenance has dangling references');
    const orphanEntities = await connection.run(
      'MATCH (e:Entity) WHERE NOT EXISTS { MATCH (:Article)-[:HAS_ENTITY]->(e) } ' +
        'AND NOT EXISTS { MATCH (e)-[:ENTITY_RELATION]-() } RETURN e.entity_id AS id LIMIT 1',
    );
    if (orphanEntities.length) throw new Error('unsupported orphan entities exist');
    const relationBatchSize = 4096;
    for (let offset = 0; ; offset += relationBatchSize) {
      const supported = await connection.run<Record<string, unknown>>(
        'MATCH (p:RelationSupport) RETURN DISTINCT p.source_entity_id AS source, ' +
          'p.relation AS relation, p.target_entity_id AS target, p.context AS context ' +
          `ORDER BY source, relation, target, context SKIP ${offset} LIMIT ${relationBatchSize}`,
      );
      const live = await connection.run<Record<string, unknown>>(
        'MATCH (s:Entity)-[r:ENTITY_RELATION]->(t:Entity) RETURN s.entity_id AS source, ' +
          'r.relation AS relation, t.entity_id AS target, r.context AS context ' +
          `ORDER BY source, relation, target, context SKIP ${offset} LIMIT ${relationBatchSize}`,
      );
      const normalizeRelations = (rows: Array<Record<string, unknown>>) =>
        rows.map((row) => ({
          source: String(row.source),
          relation: String(row.relation),
          target: String(row.target),
          context: row.context == null ? '' : String(row.context),
        }));
      if (canonical(normalizeRelations(supported)) !== canonical(normalizeRelations(live))) {
        throw new Error('live relationships do not exactly match relation support');
      }
      if (supported.length < relationBatchSize && live.length < relationBatchSize) break;
    }
    for (const [table, index, expected] of [
      ['Section', 'embedding_idx', counts.sections],
      ['Chunk', 'chunk_embedding_idx', counts.chunks],
    ] as const) {
      await validateVectorIndexMembership(connection, table, index, expected);
    }
    return {
      valid: true,
      manifest,
      metadata,
      applications,
      contentDigest: actualContentDigest,
      counts,
    };
  } finally {
    connection.close();
    database.close();
  }
}

export async function validateKnowledgePack(packDir: string): Promise<PackValidationResult> {
  try {
    return await validateKnowledgePackInternal(packDir);
  } catch (error) {
    if (error instanceof KnowledgePackValidationError) throw error;
    throw new KnowledgePackValidationError(error instanceof Error ? error.message : String(error));
  }
}
