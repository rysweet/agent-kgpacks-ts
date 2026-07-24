import { join } from 'node:path';

import { Database, type Connection } from '@kgpacks/db';
import type { PackManifest } from '@kgpacks/packs';

import { chunkArticle } from './chunking.js';
import { CVE_ADAPTER_VERSION, cveToGraph } from './cve-adapter.js';
import { loadPack, type LoadableArticle } from './loader.js';
import type { Embedder } from './types.js';
import type {
  DeltaRecord,
  ExpectedUpdate,
  ParsedDelta,
  UpdateState,
  DurablePackMetadata,
  DurableUpdateApplication,
  PackValidationResult,
  ArticleSourceIdentity,
  UpdateKnowledgePackResult,
} from './incremental-shared.js';
import {
  INCREMENTAL_SCHEMA_VERSION,
  METADATA_ID,
  UPDATE_TOOL_VERSION,
  buildIdFor,
  canonical,
  contentDigest,
  sha256,
} from './incremental-shared.js';

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
  const texts = [
    ...graph.article.sections.map((section) => section.content),
    ...chunks.map((chunk) => chunk.content),
  ];
  const embeddings = await embedder.generate(texts);
  return {
    article: graph.article,
    sectionEmbeddings: embeddings.slice(0, graph.article.sections.length),
    chunks,
    chunkEmbeddings: embeddings.slice(graph.article.sections.length),
    extraction: graph.extraction,
    sourcePayload: payload,
    sourcePayloadHash: sha256(payload),
    extractorVersion: CVE_ADAPTER_VERSION,
  };
}

export async function writeDatabase(
  path: string,
  loadables: LoadableArticle[],
  metadata: DurablePackMetadata,
): Promise<void> {
  const database = new Database(path, { autoCheckpoint: false });
  const connection = database.connect();
  try {
    await loadPack(connection, { articles: loadables, links: [] });
    await writePackMetadata(connection, metadata);
  } finally {
    connection.close();
    database.close();
  }
}

export async function databaseCounts(
  connection: Connection,
): Promise<PackValidationResult['counts']> {
  const count = async (query: string) => {
    const result = await connection.run<{ count: number | bigint }>(query);
    return Number(result[0]?.count ?? 0);
  };
  return {
    articles: await count('MATCH (n:Article) RETURN count(n) AS count'),
    sections: await count('MATCH (n:Section) RETURN count(n) AS count'),
    chunks: await count('MATCH (n:Chunk) RETURN count(n) AS count'),
    entities: await count('MATCH (n:Entity) RETURN count(n) AS count'),
    relationships: await count('MATCH ()-[r:ENTITY_RELATION]->() RETURN count(r) AS count'),
    entitySupport: await count('MATCH ()-[r:HAS_ENTITY]->() RETURN count(r) AS count'),
    relationSupport: await count('MATCH (n:RelationSupport) RETURN count(n) AS count'),
  };
}

export async function writePackMetadata(
  connection: Connection,
  metadata: DurablePackMetadata,
): Promise<void> {
  await connection.run(
    'CREATE (:PackMetadata {id: $id, pack_id: $packId, version: $version, ' +
      'schema_version: $schemaVersion, adapter_version: $adapterVersion, ' +
      'extractor_version: $extractorVersion, tool_version: $toolVersion, ' +
      'build_id: $buildId, provenance: $provenance, base_pack_id: $basePackId, ' +
      'base_version: $baseVersion, base_build_id: $baseBuildId, ' +
      'base_content_digest: $baseContentDigest, delta_id: $deltaId, ' +
      'delta_file_sha256: $deltaFileSha256})',
    {
      id: METADATA_ID,
      packId: metadata.packId,
      version: metadata.version,
      schemaVersion: metadata.schemaVersion,
      adapterVersion: metadata.adapterVersion,
      extractorVersion: metadata.extractorVersion,
      toolVersion: metadata.toolVersion,
      buildId: metadata.buildId,
      provenance: canonical(metadata.provenance),
      basePackId: metadata.basePackId ?? '',
      baseVersion: metadata.baseVersion ?? '',
      baseBuildId: metadata.baseBuildId ?? '',
      baseContentDigest: metadata.baseContentDigest ?? '',
      deltaId: metadata.deltaId ?? '',
      deltaFileSha256: metadata.deltaFileSha256 ?? '',
    },
  );
}

export async function readPackMetadata(connection: Connection): Promise<DurablePackMetadata> {
  const rows = await connection.run<Record<string, unknown>>(
    'MATCH (m:PackMetadata) RETURN m.id AS id, m.pack_id AS packId, ' +
      'm.version AS version, m.schema_version AS schemaVersion, ' +
      'm.adapter_version AS adapterVersion, m.extractor_version AS extractorVersion, ' +
      'm.tool_version AS toolVersion, m.build_id AS buildId, m.provenance AS provenance, ' +
      'm.base_pack_id AS basePackId, m.base_version AS baseVersion, ' +
      'm.base_build_id AS baseBuildId, m.base_content_digest AS baseContentDigest, ' +
      'm.delta_id AS deltaId, m.delta_file_sha256 AS deltaFileSha256',
  );
  if (rows.length !== 1 || rows[0].id !== METADATA_ID) {
    throw new Error('pack database must contain exactly one PackMetadata singleton');
  }
  const row = rows[0];
  const nullable = (value: unknown): string | null => {
    const result = String(value ?? '');
    return result === '' ? null : result;
  };
  let provenance: unknown;
  try {
    provenance = JSON.parse(String(row.provenance));
  } catch {
    throw new Error('pack database metadata provenance is invalid');
  }
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error('pack database metadata provenance is invalid');
  }
  return {
    packId: String(row.packId),
    version: String(row.version),
    schemaVersion: String(row.schemaVersion),
    adapterVersion: String(row.adapterVersion),
    extractorVersion: String(row.extractorVersion),
    toolVersion: String(row.toolVersion),
    buildId: String(row.buildId),
    provenance: provenance as Record<string, unknown>,
    basePackId: nullable(row.basePackId),
    baseVersion: nullable(row.baseVersion),
    baseBuildId: nullable(row.baseBuildId),
    baseContentDigest: nullable(row.baseContentDigest),
    deltaId: nullable(row.deltaId),
    deltaFileSha256: nullable(row.deltaFileSha256),
  };
}

export async function readUpdateApplications(
  connection: Connection,
): Promise<DurableUpdateApplication[]> {
  const rows = await connection.run<Record<string, unknown>>(
    'MATCH (u:UpdateApplication) RETURN u.article_title AS key, u.operation AS operation, ' +
      'u.base_payload_sha256 AS basePayloadSha256, ' +
      'u.result_payload_sha256 AS resultPayloadSha256, ' +
      'u.classification AS classification ORDER BY key',
  );
  return rows.map((row) => ({
    key: String(row.key),
    operation: String(row.operation) as 'upsert',
    basePayloadSha256:
      row.basePayloadSha256 == null || row.basePayloadSha256 === ''
        ? null
        : String(row.basePayloadSha256),
    resultPayloadSha256: String(row.resultPayloadSha256),
    classification: String(row.classification) as DurableUpdateApplication['classification'],
  }));
}

export function applicationCounts(applications: DurableUpdateApplication[]) {
  const counts = { added: 0, modified: 0, unchanged: 0 };
  for (const application of applications) counts[application.classification]++;
  return counts;
}

export function createManifest(input: {
  metadata: DurablePackMetadata;
  applications: DurableUpdateApplication[];
  files: Array<{ path: string; size: number; sha256: string }>;
  counts: PackValidationResult['counts'];
}): PackManifest {
  const { metadata } = input;
  const incremental = metadata.basePackId !== null;
  return {
    name: metadata.packId,
    packId: metadata.packId,
    version: metadata.version,
    schemaVersion: metadata.schemaVersion,
    adapterVersion: metadata.adapterVersion,
    extractorVersion: metadata.extractorVersion,
    toolVersion: metadata.toolVersion,
    buildId: metadata.buildId,
    provenance: metadata.provenance,
    contentDigest: contentDigest(input.files),
    files: input.files,
    lineage: incremental
      ? {
          base: {
            packId: metadata.basePackId,
            version: metadata.baseVersion,
            buildId: metadata.baseBuildId,
            contentDigest: metadata.baseContentDigest,
          },
          delta: { deltaId: metadata.deltaId, fileSha256: metadata.deltaFileSha256 },
        }
      : { base: null, delta: null },
    update: {
      ...applicationCounts(input.applications),
      records: input.applications,
    },
    graph_stats: {
      articles: input.counts.articles,
      sections: input.counts.sections,
      chunks: input.counts.chunks,
      entities: input.counts.entities,
      relationships: input.counts.relationships,
      entity_support: input.counts.entitySupport,
      relation_support: input.counts.relationSupport,
      source_records: input.counts.articles,
      update_applications: input.applications.length,
      payload_bytes: input.files.reduce((sum, file) => sum + file.size, 0),
      size_mb: Math.round((input.files[0].size / (1024 * 1024)) * 100) / 100,
    },
  };
}

export function asNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, Number);
  throw new Error('base pack contains an invalid embedding');
}

export function isFiniteEmbedding(value: unknown): boolean {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return false;
  const embedding = value as unknown as ArrayLike<unknown>;
  if (embedding.length !== 768) return false;
  for (let offset = 0; offset < embedding.length; offset++) {
    if (!Number.isFinite(Number(embedding[offset]))) return false;
  }
  return true;
}

export function groupByArticle<T extends Record<string, unknown>>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const article = String(row.article);
    const current = grouped.get(article);
    if (current) current.push(row);
    else grouped.set(article, [row]);
  }
  return grouped;
}

export async function sourceHashesForPack(packDir: string): Promise<Map<string, string>> {
  const database = new Database(join(packDir, 'pack.db'), { readOnly: true });
  const connection = database.connect();
  try {
    const rows = await connection.run<{ title: string; hash: string }>(
      'MATCH (s:ArticleSource) RETURN s.title AS title, s.payload_sha256 AS hash ORDER BY title',
    );
    const hashes = new Map(rows.map((row) => [row.title, row.hash]));
    if (hashes.size !== rows.length) throw new Error('pack contains duplicate article sources');
    return hashes;
  } finally {
    connection.close();
    database.close();
  }
}

export async function readBaseLoadables(
  connection: Connection,
  titles: string[],
): Promise<Map<string, LoadableArticle>> {
  if (titles.length === 0) return new Map();
  try {
    const articleRows = await connection.run<Record<string, unknown>>(
      'MATCH (a:Article), (src:ArticleSource) WHERE a.title = src.title ' +
        'AND a.title IN $titles ' +
        'RETURN a.title AS title, a.category AS category, a.expansion_depth AS depth, ' +
        'src.payload AS payload, src.payload_sha256 AS payloadHash, ' +
        'src.extractor_version AS extractorVersion ORDER BY title',
      { titles },
    );
    const sectionRows = await connection.run<Record<string, unknown>>(
      'MATCH (a:Article)-[r:HAS_SECTION]->(s:Section) ' +
        'WHERE a.title IN $titles ' +
        'RETURN a.title AS article, r.section_index AS idx, s.id AS id, s.title AS title, ' +
        's.content AS content, s.embedding AS embedding, s.level AS level, s.cve_id AS cveId, ' +
        's.affected_products AS affectedProducts, s.aliases AS aliases, s.cpes AS cpes, ' +
        's.purls AS purls, s.ecosystems AS ecosystems ORDER BY article, idx',
      { titles },
    );
    const chunkRows = await connection.run<Record<string, unknown>>(
      'MATCH (a:Article)-[r:HAS_CHUNK]->(c:Chunk) ' +
        'WHERE a.title IN $titles ' +
        'RETURN a.title AS article, r.section_index AS sectionIndex, r.chunk_index AS chunkIndex, ' +
        'c.id AS id, c.content AS content, c.embedding AS embedding ORDER BY article, sectionIndex, chunkIndex',
      { titles },
    );
    const sectionsByArticle = groupByArticle(sectionRows);
    const chunksByArticle = groupByArticle(chunkRows);
    const byTitle = new Map<string, LoadableArticle>();
    for (const row of articleRows) {
      const title = String(row.title);
      const sourcePayload = String(row.payload);
      const graph = cveToGraph(JSON.parse(sourcePayload));
      if (!graph || graph.article.title !== title) {
        throw new Error(`base article source does not reproduce ${title}`);
      }
      const articleSections = sectionsByArticle.get(title) ?? [];
      const articleChunks = chunksByArticle.get(title) ?? [];
      const chunks = articleChunks.map((chunk) => ({
        id: String(chunk.id),
        content: String(chunk.content),
        articleTitle: title,
        sectionIndex: Number(chunk.sectionIndex),
        chunkIndex: Number(chunk.chunkIndex),
      }));
      byTitle.set(title, {
        article: graph.article,
        sectionEmbeddings: articleSections.map((section) => asNumberArray(section.embedding)),
        chunks,
        chunkEmbeddings: articleChunks.map((chunk) => asNumberArray(chunk.embedding)),
        extraction: graph.extraction,
        expansionDepth: Number(row.depth),
        sourcePayload,
        sourcePayloadHash: String(row.payloadHash),
        extractorVersion: String(row.extractorVersion),
      });
    }
    if (byTitle.size !== articleRows.length)
      throw new Error('base article provenance is incomplete');
    return byTitle;
  } catch (error) {
    throw new Error(
      `base pack is not provenance-capable and must be rebuilt from source: ${(error as Error).message}`,
    );
  }
}

export function applicationsFor(
  baseHashes: Map<string, string>,
  delta: DeltaRecord[],
): DurableUpdateApplication[] {
  return delta.map((record) => {
    const basePayloadSha256 = baseHashes.get(record.key) ?? null;
    return {
      key: record.key,
      operation: 'upsert',
      basePayloadSha256,
      resultPayloadSha256: record.payloadHash,
      classification:
        basePayloadSha256 === null
          ? 'added'
          : basePayloadSha256 === record.payloadHash
            ? 'unchanged'
            : 'modified',
    };
  });
}

export function expectedSourceClosure(
  baseHashes: Map<string, string>,
  delta: DeltaRecord[],
): ArticleSourceIdentity[] {
  const hashes = new Map(baseHashes);
  for (const record of delta) hashes.set(record.key, record.payloadHash);
  return [...hashes]
    .map(([title, hash]) => ({ title, hash }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

export function applicationsEqual(
  left: DurableUpdateApplication[],
  right: DurableUpdateApplication[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (application, index) =>
        application.key === right[index].key &&
        application.operation === right[index].operation &&
        application.basePayloadSha256 === right[index].basePayloadSha256 &&
        application.resultPayloadSha256 === right[index].resultPayloadSha256 &&
        application.classification === right[index].classification,
    )
  );
}

export function sourceClosuresEqual(
  left: ArticleSourceIdentity[],
  right: ArticleSourceIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (source, index) => source.title === right[index].title && source.hash === right[index].hash,
    )
  );
}

export function resumeRecordsMatchDelta(
  records: UpdateState['records'],
  delta: DeltaRecord[],
): boolean {
  return (
    records.length === delta.length &&
    records.every(
      (record, index) =>
        record.ordinal === delta[index].ordinal &&
        record.key === delta[index].key &&
        record.hash === delta[index].payloadHash,
    )
  );
}

export async function sourceClosureForPack(packDir: string): Promise<ArticleSourceIdentity[]> {
  const database = new Database(join(packDir, 'pack.db'), { readOnly: true });
  const connection = database.connect();
  try {
    const rows = await connection.run<ArticleSourceIdentity>(
      'MATCH (s:ArticleSource) RETURN s.title AS title, s.payload_sha256 AS hash ORDER BY title',
    );
    for (let index = 1; index < rows.length; index++) {
      if (rows[index - 1].title === rows[index].title) {
        throw new Error('pack contains duplicate article sources');
      }
    }
    return rows;
  } finally {
    connection.close();
    database.close();
  }
}

export async function expectedUpdateFor(
  state: UpdateState,
  parsed: ParsedDelta,
  baseValidation: PackValidationResult,
): Promise<ExpectedUpdate> {
  const buildId = buildIdFor({
    packId: baseValidation.metadata.packId,
    version: state.version,
    baseContentDigest: baseValidation.contentDigest,
    deltaId: parsed.deltaId,
    embeddingModel: state.embeddingModel,
  });
  if (state.buildId !== buildId) {
    throw new Error('update build ID does not match the current base, delta, and target version');
  }
  const baseHashes = await sourceHashesForPack(state.base);
  return {
    baseMetadata: baseValidation.metadata,
    baseHashes,
    metadata: targetMetadata(baseValidation.metadata, {
      version: state.version,
      buildId,
      baseContentDigest: baseValidation.contentDigest,
      deltaId: parsed.deltaId,
      deltaFileSha256: parsed.fileSha256,
    }),
    applications: applicationsFor(baseHashes, parsed.records),
    sources: expectedSourceClosure(baseHashes, parsed.records),
  };
}

export async function assertPackMatchesExpected(
  packDir: string,
  validation: PackValidationResult,
  expected: ExpectedUpdate,
  message: string,
): Promise<void> {
  const sources = await sourceClosureForPack(packDir);
  if (
    canonical(validation.metadata) !== canonical(expected.metadata) ||
    !applicationsEqual(validation.applications, expected.applications) ||
    !sourceClosuresEqual(sources, expected.sources)
  ) {
    throw new Error(message);
  }
}

export function targetMetadata(
  base: DurablePackMetadata,
  input: {
    version: string;
    buildId: string;
    baseContentDigest: string;
    deltaId: string;
    deltaFileSha256: string;
  },
): DurablePackMetadata {
  return {
    packId: base.packId,
    version: input.version,
    schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    adapterVersion: CVE_ADAPTER_VERSION,
    extractorVersion: CVE_ADAPTER_VERSION,
    toolVersion: UPDATE_TOOL_VERSION,
    buildId: input.buildId,
    provenance: base.provenance,
    basePackId: base.packId,
    baseVersion: base.version,
    baseBuildId: base.buildId,
    baseContentDigest: input.baseContentDigest,
    deltaId: input.deltaId,
    deltaFileSha256: input.deltaFileSha256,
  };
}

export function resultFromValidation(
  state: Pick<UpdateState, 'output'>,
  validation: PackValidationResult,
  noop: boolean,
): UpdateKnowledgePackResult {
  const counts = applicationCounts(validation.applications);
  return {
    packId: validation.metadata.packId,
    version: validation.metadata.version,
    buildId: validation.metadata.buildId,
    deltaId: validation.metadata.deltaId ?? '',
    added: counts.added,
    modified: counts.modified,
    unchanged: counts.unchanged,
    noop,
    output: state.output,
  };
}
