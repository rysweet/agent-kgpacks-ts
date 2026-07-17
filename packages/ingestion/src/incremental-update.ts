import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { Database, type Connection } from '@kgpacks/db';
import { BgeEmbedder } from '@kgpacks/embeddings';
import { loadManifestFromDir, saveManifest, type PackManifest } from '@kgpacks/packs';

import { chunkArticle } from './chunking.js';
import { CVE_ADAPTER_VERSION, cveToGraph } from './cve-adapter.js';
import { loadPack, type LoadableArticle } from './loader.js';
import { createPackWriter } from './streaming-loader.js';
import type { Embedder } from './types.js';

export const INCREMENTAL_SCHEMA_VERSION = '2';
export const UPDATE_TOOL_VERSION = 'agent-kgpacks-ts@0.1.0';
const VERSION_RE = /^[0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const STATE_FILE = 'update-state.json';

interface DeltaRecord {
  ordinal: number;
  key: string;
  payload: string;
  payloadHash: string;
}

interface ParsedDelta {
  records: DeltaRecord[];
  deltaId: string;
  fileSha256: string;
}

interface UpdateState {
  phase: 'prepared' | 'delta-applied';
  base: string;
  delta: string;
  output: string;
  version: string;
  buildId: string;
  deltaId: string;
  deltaFileSha256: string;
  baseContentDigest: string;
  baseManifestSha256: string;
  basePayloadSha256: string;
  workDir: string;
  schemaVersion: string;
  extractorVersion: string;
  toolVersion: string;
  records: Array<{ ordinal: number; key: string; hash: string; processed: boolean }>;
}

export interface PackCheckpoint {
  phase: UpdateState['phase'];
  workDir: string;
}

export interface BuildCvePackConfig {
  source: string;
  output: string;
  packId: string;
  version: string;
  embedder: Embedder;
}

interface FreshUpdateConfig {
  base: string;
  delta: string;
  output: string;
  version: string;
  workDir?: string;
  embedder?: Embedder;
  onCheckpoint?: (checkpoint: PackCheckpoint) => void;
}

interface ResumeUpdateConfig {
  resume: string;
  embedder?: Embedder;
  onCheckpoint?: (checkpoint: PackCheckpoint) => void;
}

export type UpdateKnowledgePackConfig = FreshUpdateConfig | ResumeUpdateConfig;

export interface UpdateKnowledgePackResult {
  packId: string;
  version: string;
  buildId: string;
  deltaId: string;
  added: number;
  modified: number;
  unchanged: number;
  noop: boolean;
  output: string;
}

export interface PackValidationResult {
  valid: true;
  manifest: PackManifest;
  counts: {
    articles: number;
    sections: number;
    chunks: number;
    entities: number;
    relationships: number;
    entitySupport: number;
    relationSupport: number;
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function readDelta(path: string): ParsedDelta {
  const bytes = readFileSync(path);
  const records: DeltaRecord[] = [];
  const seen = new Set<string>();
  const lines = bytes
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  for (let ordinal = 0; ordinal < lines.length; ordinal++) {
    const raw = lines[ordinal];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`invalid delta record ${ordinal + 1}: ${(error as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`invalid delta record ${ordinal + 1}: expected a JSON object`);
    }
    const object = parsed as Record<string, unknown>;
    if (object.operation === 'delete') {
      throw new Error(`delete operation is not supported (${String(object.key ?? 'unknown')})`);
    }
    if (object.operation !== undefined && object.operation !== 'upsert') {
      throw new Error(`unsupported delta operation ${JSON.stringify(object.operation)}`);
    }
    const payloadObject =
      object.operation === 'upsert' && object.payload && typeof object.payload === 'object'
        ? object.payload
        : parsed;
    const metadata = (payloadObject as Record<string, unknown>).cveMetadata;
    const key =
      metadata && typeof metadata === 'object'
        ? String((metadata as Record<string, unknown>).cveId ?? '').trim()
        : String(object.key ?? '').trim();
    if (!/^CVE-\d{4}-\d+$/.test(key)) {
      throw new Error(`delta record ${ordinal + 1} has no valid CVE stable key`);
    }
    if (
      object.operation === 'upsert' &&
      object.key !== undefined &&
      String(object.key).trim() !== key
    ) {
      throw new Error(`delta record ${ordinal + 1} key does not match its CVE payload`);
    }
    if (seen.has(key)) throw new Error(`duplicate delta stable key: ${key}`);
    seen.add(key);
    const payload = JSON.stringify(payloadObject);
    const metadataObject =
      metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
    if (String(metadataObject.state ?? '').toUpperCase() === 'REJECTED') {
      throw new Error(`delete operation is not supported (${key} is REJECTED)`);
    }
    if (!cveToGraph(payloadObject)) {
      throw new Error(`delta record ${ordinal + 1} cannot be mapped by the CVE adapter`);
    }
    records.push({ ordinal, key, payload, payloadHash: sha256(payload) });
  }
  records.sort((left, right) => left.key.localeCompare(right.key));
  const deltaId = sha256(
    canonical(
      records.map((record) => ({
        operation: 'upsert',
        key: record.key,
        sourcePayloadSha256: record.payloadHash,
      })),
    ),
  );
  return { records, deltaId, fileSha256: sha256(bytes) };
}

function assertVersion(version: string): void {
  if (!VERSION_RE.test(version)) {
    throw new Error(`invalid target version ${JSON.stringify(version)}`);
  }
}

function nearestExisting(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`cannot resolve filesystem for ${path}`);
    current = parent;
  }
  return current;
}

function assertSameFilesystem(output: string, workDir: string): void {
  if (statSync(nearestExisting(dirname(output))).dev !== statSync(nearestExisting(workDir)).dev) {
    throw new Error('work directory must reside on the output filesystem');
  }
}

function canonicalPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    suffix.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(realpathSync(current), ...suffix);
}

function pathsOverlap(leftPath: string, rightPath: string): boolean {
  const left = canonicalPath(leftPath);
  const right = canonicalPath(rightPath);
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  const within = (value: string) =>
    value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
  return within(fromLeft) || within(fromRight);
}

function assertDisjointPaths(base: string, output: string, workDir: string): void {
  if (pathsOverlap(base, output) || pathsOverlap(base, workDir) || pathsOverlap(output, workDir)) {
    throw new Error('base, output, and work directory paths must not overlap');
  }
}

function writeState(state: UpdateState): void {
  mkdirSync(state.workDir, { recursive: true });
  const path = join(state.workDir, STATE_FILE);
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    fsyncFile(temporary);
    renameSync(temporary, path);
    fsyncDirectory(state.workDir);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function asUpdateState(value: unknown, path: string): UpdateState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid update resume state at ${path}`);
  }
  const state = value as Record<string, unknown>;
  const strings = [
    'base',
    'delta',
    'output',
    'version',
    'buildId',
    'deltaId',
    'deltaFileSha256',
    'baseContentDigest',
    'baseManifestSha256',
    'basePayloadSha256',
    'workDir',
    'schemaVersion',
    'extractorVersion',
    'toolVersion',
  ] as const;
  if (strings.some((key) => typeof state[key] !== 'string' || state[key] === '')) {
    throw new Error(`invalid update resume state at ${path}`);
  }
  if (
    (state.phase !== 'prepared' && state.phase !== 'delta-applied') ||
    !VERSION_RE.test(String(state.version)) ||
    ![
      state.buildId,
      state.deltaId,
      state.deltaFileSha256,
      state.baseContentDigest,
      state.baseManifestSha256,
      state.basePayloadSha256,
    ].every((hash) => SHA256_RE.test(String(hash))) ||
    ![state.base, state.delta, state.output, state.workDir].every(
      (savedPath) => typeof savedPath === 'string' && isAbsolute(savedPath),
    ) ||
    !Array.isArray(state.records)
  ) {
    throw new Error(`invalid update resume state at ${path}`);
  }
  const seen = new Set<string>();
  for (const record of state.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`invalid update resume state at ${path}`);
    }
    const item = record as Record<string, unknown>;
    if (
      !Number.isInteger(item.ordinal) ||
      Number(item.ordinal) < 0 ||
      typeof item.key !== 'string' ||
      !/^CVE-\d{4}-\d+$/.test(item.key) ||
      typeof item.hash !== 'string' ||
      !SHA256_RE.test(item.hash) ||
      typeof item.processed !== 'boolean' ||
      seen.has(item.key)
    ) {
      throw new Error(`invalid update resume state at ${path}`);
    }
    seen.add(item.key);
  }
  return value as UpdateState;
}

function readState(workDir: string): UpdateState {
  const path = join(resolve(workDir), STATE_FILE);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read update resume state at ${path}: ${(error as Error).message}`);
  }
  return asUpdateState(value, path);
}

async function fileEntry(path: string, relativePath: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path: relativePath, size: statSync(path).size, sha256: hash.digest('hex') };
}

function contentDigest(files: Array<{ path: string; size: number; sha256: string }>): string {
  return sha256(canonical([...files].sort((a, b) => a.path.localeCompare(b.path))));
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function manifestPayloadSha256(manifest: PackManifest): string {
  const files = manifest.files;
  if (!Array.isArray(files)) throw new Error('base manifest has no payload checksums');
  const pack = files.find(
    (entry) =>
      entry && typeof entry === 'object' && (entry as Record<string, unknown>).path === 'pack.db',
  ) as Record<string, unknown> | undefined;
  if (!pack || typeof pack.sha256 !== 'string' || !SHA256_RE.test(pack.sha256)) {
    throw new Error('base manifest has no valid pack.db checksum');
  }
  return pack.sha256;
}

async function assertBaseUnchanged(state: UpdateState): Promise<void> {
  const names = readdirSync(state.base).sort();
  if (canonical(names) !== canonical(['manifest.json', 'pack.db'])) {
    throw new Error('base pack files changed during the update');
  }
  if (sha256(readFileSync(join(state.base, 'manifest.json'))) !== state.baseManifestSha256) {
    throw new Error('base manifest changed during the update');
  }
  const payload = await fileEntry(join(state.base, 'pack.db'), 'pack.db');
  if (payload.sha256 !== state.basePayloadSha256) {
    throw new Error('base payload changed during the update');
  }
}

async function toLoadable(payload: string, embedder: Embedder): Promise<LoadableArticle> {
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

async function writeDatabase(path: string, loadables: LoadableArticle[]): Promise<void> {
  const database = new Database(path, { autoCheckpoint: false });
  const connection = database.connect();
  try {
    await loadPack(connection, { articles: loadables, links: [] });
  } finally {
    connection.close();
    database.close();
  }
}

async function databaseCounts(connection: Connection): Promise<PackValidationResult['counts']> {
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

function createManifest(input: {
  packId: string;
  version: string;
  buildId: string;
  files: Array<{ path: string; size: number; sha256: string }>;
  counts: PackValidationResult['counts'];
  lineage?: Record<string, unknown>;
  update?: Record<string, unknown>;
}): PackManifest {
  return {
    name: input.packId,
    packId: input.packId,
    version: input.version,
    schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    adapterVersion: CVE_ADAPTER_VERSION,
    extractorVersion: CVE_ADAPTER_VERSION,
    toolVersion: UPDATE_TOOL_VERSION,
    buildId: input.buildId,
    contentDigest: contentDigest(input.files),
    files: input.files,
    ...(input.lineage ? { lineage: input.lineage } : {}),
    ...(input.update ? { update: input.update } : {}),
    graph_stats: {
      articles: input.counts.articles,
      sections: input.counts.sections,
      chunks: input.counts.chunks,
      entities: input.counts.entities,
      relationships: input.counts.relationships,
      entity_support: input.counts.entitySupport,
      relation_support: input.counts.relationSupport,
      size_mb: Math.round((input.files[0].size / (1024 * 1024)) * 100) / 100,
    },
  };
}

async function finalizePack(
  staging: string,
  manifestInput: Omit<Parameters<typeof createManifest>[0], 'files' | 'counts'>,
): Promise<PackManifest> {
  const database = new Database(join(staging, 'pack.db'), { readOnly: true });
  const connection = database.connect();
  let counts: PackValidationResult['counts'];
  try {
    counts = await databaseCounts(connection);
  } finally {
    connection.close();
    database.close();
  }
  const files = [await fileEntry(join(staging, 'pack.db'), 'pack.db')];
  const manifest = createManifest({ ...manifestInput, files, counts });
  saveManifest(join(staging, 'manifest.json'), manifest);
  await validateKnowledgePack(staging);
  fsyncFile(join(staging, 'pack.db'));
  fsyncFile(join(staging, 'manifest.json'));
  fsyncDirectory(staging);
  return manifest;
}

/** Builds a small provenance-capable CVE pack from an NDJSON corpus. */
export async function buildCvePack(config: BuildCvePackConfig): Promise<void> {
  assertVersion(config.version);
  if (existsSync(config.output)) throw new Error(`output already exists: ${config.output}`);
  const parsed = readDelta(config.source);
  const buildId = sha256(
    canonical({
      packId: config.packId,
      version: config.version,
      deltaId: parsed.deltaId,
      schemaVersion: INCREMENTAL_SCHEMA_VERSION,
      extractorVersion: CVE_ADAPTER_VERSION,
      toolVersion: UPDATE_TOOL_VERSION,
    }),
  );
  const staging = `${resolve(config.output)}.build-${buildId.slice(0, 12)}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const loadables = [];
    for (const record of parsed.records)
      loadables.push(await toLoadable(record.payload, config.embedder));
    await writeDatabase(join(staging, 'pack.db'), loadables);
    await finalizePack(staging, {
      packId: config.packId,
      version: config.version,
      buildId,
    });
    renameSync(staging, resolve(config.output));
    fsyncDirectory(dirname(resolve(config.output)));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function asNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, Number);
  throw new Error('base pack contains an invalid embedding');
}

function groupByArticle<T extends Record<string, unknown>>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const article = String(row.article);
    const current = grouped.get(article);
    if (current) current.push(row);
    else grouped.set(article, [row]);
  }
  return grouped;
}

async function readBaseLoadables(
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

function updateCounts(
  baseHashes: Map<string, string>,
  delta: DeltaRecord[],
): { added: number; modified: number; unchanged: number } {
  let added = 0;
  let modified = 0;
  let unchanged = 0;
  for (const record of delta) {
    const priorHash = baseHashes.get(record.key);
    if (!priorHash) added++;
    else if (priorHash === record.payloadHash) unchanged++;
    else modified++;
  }
  return { added, modified, unchanged };
}

function resultFromManifest(
  state: UpdateState,
  manifest: PackManifest,
  noop: boolean,
): UpdateKnowledgePackResult {
  const counts = manifest.update as Record<string, unknown>;
  return {
    packId: String(manifest.packId),
    version: state.version,
    buildId: state.buildId,
    deltaId: state.deltaId,
    added: Number(counts.added),
    modified: Number(counts.modified),
    unchanged: Number(counts.unchanged),
    noop,
    output: state.output,
  };
}

async function publishStagedPack(state: UpdateState): Promise<UpdateKnowledgePackResult> {
  const staging = join(state.workDir, 'staging');
  if (!existsSync(staging) || !statSync(staging).isDirectory()) {
    throw new Error(`completed update staging directory is missing at ${staging}`);
  }
  const validation = await validateKnowledgePack(staging);
  if (
    validation.manifest.buildId !== state.buildId ||
    validation.manifest.version !== state.version ||
    validation.manifest.packId !== loadManifestFromDir(state.base).packId
  ) {
    throw new Error('completed update staging identity does not match its resume state');
  }
  await assertBaseUnchanged(state);
  if (existsSync(state.output)) throw new Error(`output collision at ${state.output}`);
  renameSync(staging, state.output);
  fsyncDirectory(dirname(state.output));
  rmSync(state.workDir, { recursive: true, force: true });
  return resultFromManifest(state, validation.manifest, false);
}

async function resetGeneratedStructures(connection: Connection): Promise<void> {
  await connection.loadExtension('vector');
  const indexes = await connection.run<{ tableName: string; indexName: string }>(
    'CALL SHOW_INDEXES() RETURN table_name AS tableName, index_name AS indexName',
  );
  for (const { tableName, indexName } of indexes) {
    if (
      (tableName === 'Section' && indexName === 'embedding_idx') ||
      (tableName === 'Chunk' && indexName === 'chunk_embedding_idx')
    ) {
      await connection.run(`CALL DROP_VECTOR_INDEX('${tableName}', '${indexName}')`);
    }
  }
  await connection.run('MATCH ()-[r:ENTITY_RELATION]->() DELETE r');
  await connection.run('MATCH ()-[r:LINKS_TO]->() DELETE r');
  await connection.run('MATCH (n:UpdateApplication) DELETE n');
}

async function executeUpdate(
  state: UpdateState,
  parsed: ParsedDelta,
  embedder: Embedder,
  onCheckpoint?: (checkpoint: PackCheckpoint) => void,
): Promise<UpdateKnowledgePackResult> {
  if (state.phase === 'delta-applied') return publishStagedPack(state);

  const baseDatabase = new Database(join(state.base, 'pack.db'), { readOnly: true });
  const baseConnection = baseDatabase.connect();
  let baseHashes: Map<string, string>;
  let counts: { added: number; modified: number; unchanged: number };
  try {
    const sourceRows = await baseConnection.run<{ title: string; hash: string }>(
      'MATCH (s:ArticleSource) RETURN s.title AS title, s.payload_sha256 AS hash ORDER BY title',
    );
    baseHashes = new Map(sourceRows.map((row) => [row.title, row.hash]));
    counts = updateCounts(baseHashes, parsed.records);
  } catch (error) {
    baseConnection.close();
    baseDatabase.close();
    throw error;
  }

  const staging = join(state.workDir, 'staging');
  const stagingDatabase = join(staging, 'pack.db');
  const resumingStaging = existsSync(stagingDatabase);
  if (!resumingStaging) {
    if (state.records.some((record) => record.processed)) {
      throw new Error('update resume checkpoint has no corresponding staged database');
    }
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
  } else {
    rmSync(`${stagingDatabase}.wal`, { force: true });
  }
  const outputDatabase = new Database(stagingDatabase, { autoCheckpoint: false });
  const outputConnection = outputDatabase.connect();
  try {
    if (resumingStaging) await resetGeneratedStructures(outputConnection);
    const loadedTitles = new Set<string>();
    if (resumingStaging) {
      const loadedSources = await outputConnection.run<{ title: string; hash: string }>(
        'MATCH (s:ArticleSource) RETURN s.title AS title, s.payload_sha256 AS hash',
      );
      const loadedHashes = new Map(loadedSources.map((source) => [source.title, source.hash]));
      const checkpoints = new Map(state.records.map((record) => [record.key, record]));
      for (const source of loadedSources) loadedTitles.add(source.title);
      for (const record of parsed.records) {
        const loadedHash = loadedHashes.get(record.key);
        if (loadedHash !== undefined && loadedHash !== record.payloadHash) {
          throw new Error(`staged delta payload does not match its checkpoint: ${record.key}`);
        }
        const checkpoint = checkpoints.get(record.key);
        if (checkpoint?.processed && loadedHash === undefined) {
          throw new Error(`processed delta record is missing from staging: ${record.key}`);
        }
        if (checkpoint && loadedHash === record.payloadHash) checkpoint.processed = true;
      }
      writeState(state);
    }
    const writer = await createPackWriter(outputConnection, {
      insertChunkSize: 500,
      resume: resumingStaging,
    });
    const deltaByKey = new Map(parsed.records.map((record) => [record.key, record]));
    const finalTitles = [...new Set([...baseHashes.keys(), ...deltaByKey.keys()])].sort();
    const batchSize = 256;
    for (let offset = 0; offset < finalTitles.length; offset += batchSize) {
      const batchTitles = finalTitles
        .slice(offset, offset + batchSize)
        .filter((title) => !loadedTitles.has(title));
      if (batchTitles.length === 0) continue;
      const baseTitles = batchTitles.filter((title) => {
        const record = deltaByKey.get(title);
        return !record || baseHashes.get(title) === record.payloadHash;
      });
      const baseItems = await readBaseLoadables(baseConnection, baseTitles);
      const items = [...baseItems.values()];
      for (const title of batchTitles) {
        const record = deltaByKey.get(title);
        if (record && baseHashes.get(title) !== record.payloadHash) {
          items.push(await toLoadable(record.payload, embedder));
        }
      }
      items.sort((left, right) => left.article.title.localeCompare(right.article.title));
      await outputConnection.run('BEGIN TRANSACTION');
      try {
        await writer.addBatch(items);
        await outputConnection.run('COMMIT');
      } catch (error) {
        try {
          await outputConnection.run('ROLLBACK');
        } catch {
          // The failed statement may already have aborted the transaction.
        }
        throw error;
      }
      await outputConnection.run('CHECKPOINT');
      for (const title of batchTitles) {
        loadedTitles.add(title);
        const checkpoint = state.records.find((record) => record.key === title);
        if (checkpoint) checkpoint.processed = true;
      }
      writeState(state);
      onCheckpoint?.({ phase: state.phase, workDir: state.workDir });
    }
    if (state.records.some((record) => !record.processed)) {
      throw new Error('not all delta records reached a durable update checkpoint');
    }
    await writer.finalize([]);
    const applications = parsed.records.map((record) => {
      const basePayloadSha256 = baseHashes.get(record.key) ?? '';
      return {
        key: record.key,
        sourcePayloadSha256: record.payloadHash,
        basePayloadSha256,
        result:
          basePayloadSha256 === ''
            ? 'added'
            : basePayloadSha256 === record.payloadHash
              ? 'unchanged'
              : 'modified',
      };
    });
    for (let offset = 0; offset < applications.length; offset += 500) {
      await outputConnection.run(
        'UNWIND $records AS r CREATE (:UpdateApplication {article_title: r.key, ' +
          'source_payload_sha256: r.sourcePayloadSha256, ' +
          'base_payload_sha256: r.basePayloadSha256, result: r.result})',
        { records: applications.slice(offset, offset + 500) },
      );
    }
    if (applications.length > 0) {
      await outputConnection.run('CHECKPOINT');
    }
  } finally {
    outputConnection.close();
    outputDatabase.close();
    baseConnection.close();
    baseDatabase.close();
  }
  await finalizePack(staging, {
    packId: String(loadManifestFromDir(state.base).packId),
    version: state.version,
    buildId: state.buildId,
    lineage: {
      base: {
        packId: String(loadManifestFromDir(state.base).packId),
        version: loadManifestFromDir(state.base).version,
        buildId: loadManifestFromDir(state.base).buildId,
        contentDigest: state.baseContentDigest,
      },
      delta: { deltaId: state.deltaId, fileSha256: state.deltaFileSha256 },
    },
    update: {
      ...counts,
      records: parsed.records.map((record) => {
        const basePayloadSha256 = baseHashes.get(record.key) ?? null;
        return {
          key: record.key,
          sourcePayloadSha256: record.payloadHash,
          basePayloadSha256,
          result:
            basePayloadSha256 === null
              ? 'added'
              : basePayloadSha256 === record.payloadHash
                ? 'unchanged'
                : 'modified',
        };
      }),
    },
  });
  state.phase = 'delta-applied';
  state.records = state.records.map((record) => ({ ...record, processed: true }));
  writeState(state);
  onCheckpoint?.({ phase: state.phase, workDir: state.workDir });
  return publishStagedPack(state);
}

/** Applies or resumes an immutable, provenance-aware CVE pack update. */
export async function updateKnowledgePack(
  config: UpdateKnowledgePackConfig,
): Promise<UpdateKnowledgePackResult> {
  if ('resume' in config) {
    const state = readState(config.resume);
    if (resolve(config.resume) !== resolve(state.workDir)) {
      throw new Error('update resume state does not match the requested work directory');
    }
    assertDisjointPaths(state.base, state.output, state.workDir);
    if (
      state.schemaVersion !== INCREMENTAL_SCHEMA_VERSION ||
      state.extractorVersion !== CVE_ADAPTER_VERSION ||
      state.toolVersion !== UPDATE_TOOL_VERSION
    ) {
      throw new Error('update resume state was created by incompatible tool/schema versions');
    }
    const baseValidation = await validateKnowledgePack(state.base);
    if (
      baseValidation.manifest.contentDigest !== state.baseContentDigest ||
      sha256(readFileSync(join(state.base, 'manifest.json'))) !== state.baseManifestSha256 ||
      manifestPayloadSha256(baseValidation.manifest) !== state.basePayloadSha256
    ) {
      throw new Error('base input changed since the interrupted update');
    }
    const parsed = readDelta(state.delta);
    if (parsed.fileSha256 !== state.deltaFileSha256 || parsed.deltaId !== state.deltaId) {
      throw new Error('delta input changed since the interrupted update');
    }
    const expectedRecords = parsed.records.map((record) => ({
      ordinal: record.ordinal,
      key: record.key,
      hash: record.payloadHash,
    }));
    const savedRecords = state.records.map(({ ordinal, key, hash }) => ({ ordinal, key, hash }));
    if (
      canonical(savedRecords) !== canonical(expectedRecords) ||
      (state.phase === 'delta-applied' && state.records.some((record) => !record.processed))
    ) {
      throw new Error('update resume record checkpoints do not match the delta');
    }
    if (existsSync(state.output)) {
      if (!statSync(state.output).isDirectory()) {
        throw new Error(`output collision at ${state.output}`);
      }
      const completed = await validateKnowledgePack(state.output);
      if (completed.manifest.buildId !== state.buildId) {
        throw new Error(`output collision at ${state.output}`);
      }
      await assertBaseUnchanged(state);
      rmSync(state.workDir, { recursive: true, force: true });
      return resultFromManifest(state, completed.manifest, true);
    }
    return executeUpdate(state, parsed, config.embedder ?? new BgeEmbedder(), config.onCheckpoint);
  }

  assertVersion(config.version);
  const base = resolve(config.base);
  const deltaPath = resolve(config.delta);
  const output = resolve(config.output);
  if (base === output) throw new Error('output must be distinct from the base pack');
  const parsed = readDelta(deltaPath);
  const baseValidation = await validateKnowledgePack(base);
  const baseManifest = baseValidation.manifest;
  if (config.version === baseManifest.version) {
    throw new Error('target version must differ from the base version');
  }
  if (
    baseManifest.schemaVersion !== INCREMENTAL_SCHEMA_VERSION ||
    baseManifest.adapterVersion !== CVE_ADAPTER_VERSION
  ) {
    throw new Error('base pack is not provenance-capable and must be rebuilt from source');
  }
  const packId = String(baseManifest.packId ?? baseManifest.name);
  const buildId = sha256(
    canonical({
      packId,
      version: config.version,
      baseContentDigest: baseManifest.contentDigest,
      deltaId: parsed.deltaId,
      schemaVersion: INCREMENTAL_SCHEMA_VERSION,
      extractorVersion: CVE_ADAPTER_VERSION,
      toolVersion: UPDATE_TOOL_VERSION,
    }),
  );
  const workDir = resolve(config.workDir ?? `${output}.work`);
  assertDisjointPaths(base, output, workDir);
  assertSameFilesystem(output, workDir);
  if (existsSync(workDir)) {
    throw new Error(`incomplete update work exists at ${workDir}; use --resume ${workDir}`);
  }
  if (existsSync(output)) {
    if (statSync(output).isDirectory()) {
      const existing = await validateKnowledgePack(output);
      if (existing.manifest.buildId === buildId) {
        const counts = existing.manifest.update as Record<string, number>;
        return {
          packId,
          version: config.version,
          buildId,
          deltaId: parsed.deltaId,
          added: counts.added,
          modified: counts.modified,
          unchanged: counts.unchanged,
          noop: true,
          output,
        };
      }
    }
    throw new Error(`output collision: ${output} already exists`);
  }
  const state: UpdateState = {
    phase: 'prepared',
    base,
    delta: deltaPath,
    output,
    version: config.version,
    buildId,
    deltaId: parsed.deltaId,
    deltaFileSha256: parsed.fileSha256,
    baseContentDigest: String(baseManifest.contentDigest),
    baseManifestSha256: sha256(readFileSync(join(base, 'manifest.json'))),
    basePayloadSha256: manifestPayloadSha256(baseManifest),
    workDir,
    schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    extractorVersion: CVE_ADAPTER_VERSION,
    toolVersion: UPDATE_TOOL_VERSION,
    records: parsed.records.map((record) => ({
      ordinal: record.ordinal,
      key: record.key,
      hash: record.payloadHash,
      processed: false,
    })),
  };
  writeState(state);
  return executeUpdate(state, parsed, config.embedder ?? new BgeEmbedder(), config.onCheckpoint);
}

/** Comprehensively validates an update-capable pack and its generated indexes. */
export async function validateKnowledgePack(packDir: string): Promise<PackValidationResult> {
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
  if (manifest.lineage !== undefined) {
    const lineage = manifest.lineage as Record<string, unknown>;
    const base = lineage.base as Record<string, unknown> | undefined;
    const delta = lineage.delta as Record<string, unknown> | undefined;
    if (
      !base ||
      base.packId !== manifest.packId ||
      typeof base.version !== 'string' ||
      base.version === manifest.version ||
      typeof base.buildId !== 'string' ||
      !SHA256_RE.test(base.buildId) ||
      typeof base.contentDigest !== 'string' ||
      !SHA256_RE.test(base.contentDigest) ||
      !delta ||
      typeof delta.deltaId !== 'string' ||
      !SHA256_RE.test(delta.deltaId) ||
      typeof delta.fileSha256 !== 'string' ||
      !SHA256_RE.test(delta.fileSha256)
    ) {
      throw new Error('manifest update ancestry is invalid');
    }
    const update = manifest.update as Record<string, unknown> | undefined;
    if (
      !update ||
      !['added', 'modified', 'unchanged'].every(
        (key) => Number.isInteger(update[key]) && Number(update[key]) >= 0,
      )
    ) {
      throw new Error('manifest delta application counts are invalid');
    }
    if (!Array.isArray(update.records)) {
      throw new Error('manifest delta application evidence is invalid');
    }
    const applicationKeys = new Set<string>();
    const applicationCounts = { added: 0, modified: 0, unchanged: 0 };
    const applicationRecords: Array<{ key: string; sourcePayloadSha256: string }> = [];
    for (const value of update.records) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('manifest delta application evidence is invalid');
      }
      const record = value as Record<string, unknown>;
      const key = record.key;
      const sourcePayloadSha256 = record.sourcePayloadSha256;
      const basePayloadSha256 = record.basePayloadSha256;
      const result = record.result;
      if (
        typeof key !== 'string' ||
        !/^CVE-\d{4}-\d+$/.test(key) ||
        applicationKeys.has(key) ||
        typeof sourcePayloadSha256 !== 'string' ||
        !SHA256_RE.test(sourcePayloadSha256) ||
        (basePayloadSha256 !== null &&
          (typeof basePayloadSha256 !== 'string' || !SHA256_RE.test(basePayloadSha256))) ||
        (result !== 'added' && result !== 'modified' && result !== 'unchanged') ||
        (result === 'added' && basePayloadSha256 !== null) ||
        (result === 'modified' &&
          (basePayloadSha256 === null || basePayloadSha256 === sourcePayloadSha256)) ||
        (result === 'unchanged' && basePayloadSha256 !== sourcePayloadSha256)
      ) {
        throw new Error('manifest delta application evidence is invalid');
      }
      applicationKeys.add(key);
      applicationCounts[result]++;
      applicationRecords.push({ key, sourcePayloadSha256 });
    }
    const sortedApplicationRecords = [...applicationRecords].sort((left, right) =>
      left.key.localeCompare(right.key),
    );
    if (
      canonical(applicationRecords) !== canonical(sortedApplicationRecords) ||
      canonical(applicationCounts) !==
        canonical({
          added: update.added,
          modified: update.modified,
          unchanged: update.unchanged,
        }) ||
      sha256(
        canonical(
          applicationRecords.map((record) => ({
            operation: 'upsert',
            key: record.key,
            sourcePayloadSha256: record.sourcePayloadSha256,
          })),
        ),
      ) !== delta.deltaId
    ) {
      throw new Error('manifest delta application evidence does not match its counts or delta ID');
    }
    const expectedBuildId = sha256(
      canonical({
        packId: manifest.packId,
        version: manifest.version,
        baseContentDigest: base.contentDigest,
        deltaId: delta.deltaId,
        schemaVersion: manifest.schemaVersion,
        extractorVersion: manifest.extractorVersion,
        toolVersion: manifest.toolVersion,
      }),
    );
    if (expectedBuildId !== manifest.buildId) {
      throw new Error('manifest build ID does not match its canonical update inputs');
    }
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
  for (const entry of listed) {
    if (!entry || typeof entry !== 'object') throw new Error('manifest contains an invalid file');
    const file = entry as Record<string, unknown>;
    const relative = String(file.path);
    expectedFiles.add(relative);
    const actual = await fileEntry(join(dir, relative), relative);
    if (actual.size !== file.size || actual.sha256 !== file.sha256) {
      throw new Error(`payload checksum mismatch: ${relative}`);
    }
  }
  const actualFiles = readdirSync(dir).sort();
  const unlisted = actualFiles.filter((name) => !expectedFiles.has(name));
  if (unlisted.length) throw new Error(`unlisted payload files: ${unlisted.join(', ')}`);
  if (
    contentDigest(listed as Array<{ path: string; size: number; sha256: string }>) !==
    manifest.contentDigest
  ) {
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
    const graphStats = manifest.graph_stats ?? {};
    for (const [key, actual] of [
      ['articles', counts.articles],
      ['sections', counts.sections],
      ['chunks', counts.chunks],
      ['entities', counts.entities],
      ['relationships', counts.relationships],
      ['entity_support', counts.entitySupport],
      ['relation_support', counts.relationSupport],
    ] as const) {
      if (graphStats[key] !== actual) throw new Error(`manifest count mismatch: ${key}`);
    }
    const expectedSizeMb =
      Math.round((Number((listed[0] as Record<string, unknown>).size) / (1024 * 1024)) * 100) / 100;
    if (graphStats.size_mb !== expectedSizeMb) {
      throw new Error('manifest count mismatch: size_mb');
    }
    const applicationSourceHashes = new Map<string, string>();
    if (manifest.lineage !== undefined) {
      const applicationRecords = (manifest.update as Record<string, unknown>).records as Array<
        Record<string, unknown>
      >;
      for (const record of applicationRecords) {
        applicationSourceHashes.set(String(record.key), String(record.sourcePayloadSha256));
      }
      const databaseApplications = await connection.run<{
        key: string;
        sourcePayloadSha256: string;
        basePayloadSha256: string;
        result: string;
      }>(
        'MATCH (u:UpdateApplication) RETURN u.article_title AS key, ' +
          'u.source_payload_sha256 AS sourcePayloadSha256, ' +
          'u.base_payload_sha256 AS basePayloadSha256, u.result AS result ORDER BY key',
      );
      const manifestApplications = applicationRecords.map((record) => ({
        key: String(record.key),
        sourcePayloadSha256: String(record.sourcePayloadSha256),
        basePayloadSha256:
          record.basePayloadSha256 === null ? '' : String(record.basePayloadSha256),
        result: String(record.result),
      }));
      if (canonical(databaseApplications) !== canonical(manifestApplications)) {
        throw new Error('manifest delta application evidence does not match the pack database');
      }
    } else {
      const applications = await connection.run<{ count: number | bigint }>(
        'MATCH (u:UpdateApplication) RETURN count(u) AS count',
      );
      if (Number(applications[0]?.count ?? 0) !== 0) {
        throw new Error('base pack contains unexpected delta application evidence');
      }
    }
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
              'manifest delta application evidence does not match final article sources',
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
      throw new Error('manifest delta application evidence does not match final article sources');
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
    const vector = `[${new Array(768).fill('0').join(',')}]`;
    for (const [table, index, expected] of [
      ['Section', 'embedding_idx', counts.sections],
      ['Chunk', 'chunk_embedding_idx', counts.chunks],
    ] as const) {
      const indexed = await connection.run<{
        indexed: number | bigint;
        uniqueCount: number | bigint;
      }>(
        `CALL QUERY_VECTOR_INDEX('${table}', '${index}', ${vector}, ${expected + 1}) ` +
          'RETURN count(node) AS indexed, count(DISTINCT node.id) AS uniqueCount',
      );
      const live = await connection.run<{ liveCount: number | bigint }>(
        `CALL QUERY_VECTOR_INDEX('${table}', '${index}', ${vector}, ${expected + 1}) ` +
          `WITH node MATCH (live:${table} {id: node.id}) RETURN count(live) AS liveCount`,
      );
      if (
        Number(indexed[0]?.indexed ?? 0) !== expected ||
        Number(indexed[0]?.uniqueCount ?? 0) !== expected ||
        Number(live[0]?.liveCount ?? 0) !== expected
      ) {
        throw new Error(`${index} membership does not match live ${table} rows`);
      }
    }
    return { valid: true, manifest, counts };
  } finally {
    connection.close();
    database.close();
  }
}
