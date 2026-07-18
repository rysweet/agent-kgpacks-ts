import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
import { KnowledgePackUpdateError, KnowledgePackValidationError } from './errors.js';
import { loadPack, type LoadableArticle } from './loader.js';
import { createPackWriter } from './streaming-loader.js';
import type { Embedder } from './types.js';

export const INCREMENTAL_SCHEMA_VERSION = '2';
export const UPDATE_TOOL_VERSION = 'agent-kgpacks-ts@0.1.0';
const VERSION_RE = /^[0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const STATE_FILE = 'update-state.json';
const METADATA_ID = 'pack';
const PROVENANCE = {
  corpus: { name: 'cve-records', commit: null, date: null },
  embedding: { model: 'configured-embedder', dimensions: 768 },
  build: { tool_version: UPDATE_TOOL_VERSION },
} as const;

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

export interface PublishBuiltCvePackConfig {
  staging: string;
  output: string;
  packId: string;
  version: string;
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
  metadata: DurablePackMetadata;
  applications: DurableUpdateApplication[];
  contentDigest: string;
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

export interface DurablePackMetadata {
  packId: string;
  version: string;
  schemaVersion: string;
  adapterVersion: string;
  extractorVersion: string;
  toolVersion: string;
  buildId: string;
  provenance: Record<string, unknown>;
  basePackId: string | null;
  baseVersion: string | null;
  baseBuildId: string | null;
  baseContentDigest: string | null;
  deltaId: string | null;
  deltaFileSha256: string | null;
}

export interface DurableUpdateApplication {
  key: string;
  operation: 'upsert';
  basePayloadSha256: string | null;
  resultPayloadSha256: string;
  classification: 'added' | 'modified' | 'unchanged';
}

interface ArticleSourceIdentity {
  title: string;
  hash: string;
}

interface ExpectedUpdate {
  metadata: DurablePackMetadata;
  applications: DurableUpdateApplication[];
  sources: ArticleSourceIdentity[];
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

function assertScalarStrings(value: unknown, location: string): void {
  const check = (text: string): void => {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new Error(`${location} contains an unpaired Unicode surrogate`);
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error(`${location} contains an unpaired Unicode surrogate`);
      }
    }
  };
  if (typeof value === 'string') check(value);
  else if (Array.isArray(value)) value.forEach((item) => assertScalarStrings(item, location));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      check(key);
      assertScalarStrings(child, location);
    }
  }
}

function readDelta(path: string): ParsedDelta {
  const bytes = readFileSync(path);
  const records: DeltaRecord[] = [];
  const seen = new Set<string>();
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('delta is not valid UTF-8');
  }
  const lines = decoded.split(/\r?\n/).filter((line) => line.trim() !== '');
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
    if (object.operation === 'upsert') {
      const keys = Object.keys(object).sort();
      if (canonical(keys) !== canonical(['key', 'operation', 'payload']) || !object.payload) {
        throw new Error(`invalid delta record ${ordinal + 1}: malformed upsert envelope`);
      }
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
    if (object.key !== undefined && String(object.key).trim() !== key) {
      throw new Error(`delta record ${ordinal + 1} key does not match its CVE payload`);
    }
    if (seen.has(key)) throw new Error(`duplicate delta stable key: ${key}`);
    seen.add(key);
    assertScalarStrings(payloadObject, `delta record ${ordinal + 1}`);
    const payload = canonical(payloadObject);
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
  if (!lstatSync(state.workDir).isDirectory()) {
    throw new Error(`update work path is not a directory: ${state.workDir}`);
  }
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
  return sha256(
    canonical([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
  );
}

function buildIdFor(input: {
  packId: string;
  version: string;
  baseContentDigest: string | null;
  deltaId: string | null;
}): string {
  return sha256(
    canonical({
      ...input,
      schemaVersion: INCREMENTAL_SCHEMA_VERSION,
      adapterVersion: CVE_ADAPTER_VERSION,
      extractorVersion: CVE_ADAPTER_VERSION,
      toolVersion: UPDATE_TOOL_VERSION,
    }),
  );
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

function assertNoReplacePublicationAvailable(): void {
  if (process.platform !== 'linux') {
    throw new Error('atomic no-replace publication requires Linux renameat2 support');
  }
  const probe = spawnSync('mv', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0 || !probe.stdout.includes('GNU coreutils')) {
    throw new Error('atomic no-replace publication requires GNU mv with renameat2 support');
  }
}

/**
 * GNU mv uses renameat2(RENAME_NOREPLACE) for same-filesystem `--no-clobber`
 * directory promotion. Unlike Node's rename(), this cannot replace a destination
 * created between preflight and the syscall.
 */
function publishDirectoryNoReplace(staging: string, output: string): boolean {
  const moved = spawnSync('mv', ['--no-clobber', '--no-target-directory', '--', staging, output], {
    encoding: 'utf8',
  });
  if (moved.error || moved.status !== 0) {
    throw new Error(
      `atomic no-replace publication failed: ${moved.error?.message ?? moved.stderr.trim()}`,
    );
  }
  if (existsSync(staging)) return false;
  if (!existsSync(output)) throw new Error('atomic publication completed without an output');
  return true;
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

async function writeDatabase(
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

async function writePackMetadata(
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

async function readPackMetadata(connection: Connection): Promise<DurablePackMetadata> {
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

async function readUpdateApplications(connection: Connection): Promise<DurableUpdateApplication[]> {
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

function applicationCounts(applications: DurableUpdateApplication[]) {
  const counts = { added: 0, modified: 0, unchanged: 0 };
  for (const application of applications) counts[application.classification]++;
  return counts;
}

function createManifest(input: {
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

async function finalizePack(staging: string, metadata: DurablePackMetadata): Promise<PackManifest> {
  const database = new Database(join(staging, 'pack.db'), { readOnly: true });
  const connection = database.connect();
  let counts: PackValidationResult['counts'];
  let durableMetadata: DurablePackMetadata;
  let applications: DurableUpdateApplication[];
  try {
    counts = await databaseCounts(connection);
    durableMetadata = await readPackMetadata(connection);
    applications = await readUpdateApplications(connection);
  } finally {
    connection.close();
    database.close();
  }
  const files = [await fileEntry(join(staging, 'pack.db'), 'pack.db')];
  if (canonical(durableMetadata) !== canonical(metadata)) {
    throw new Error('durable pack metadata changed before finalization');
  }
  const manifest = createManifest({ metadata: durableMetadata, applications, files, counts });
  saveManifest(join(staging, 'manifest.json'), manifest);
  await validateKnowledgePack(staging);
  fsyncFile(join(staging, 'pack.db'));
  fsyncFile(join(staging, 'manifest.json'));
  fsyncDirectory(staging);
  fsyncDirectory(dirname(staging));
  return manifest;
}

/** Builds a small provenance-capable CVE pack from an NDJSON corpus. */
export async function buildCvePack(config: BuildCvePackConfig): Promise<void> {
  assertVersion(config.version);
  if (existsSync(config.output)) throw new Error(`output already exists: ${config.output}`);
  const parsed = readDelta(config.source);
  assertNoReplacePublicationAvailable();
  const buildId = buildIdFor({
    packId: config.packId,
    version: config.version,
    baseContentDigest: null,
    deltaId: null,
  });
  const metadata: DurablePackMetadata = {
    packId: config.packId,
    version: config.version,
    schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    adapterVersion: CVE_ADAPTER_VERSION,
    extractorVersion: CVE_ADAPTER_VERSION,
    toolVersion: UPDATE_TOOL_VERSION,
    buildId,
    provenance: PROVENANCE,
    basePackId: null,
    baseVersion: null,
    baseBuildId: null,
    baseContentDigest: null,
    deltaId: null,
    deltaFileSha256: null,
  };
  const staging = `${resolve(config.output)}.build-${buildId.slice(0, 12)}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const loadables = [];
    for (const record of parsed.records)
      loadables.push(await toLoadable(record.payload, config.embedder));
    await writeDatabase(join(staging, 'pack.db'), loadables, metadata);
    await publishBuiltCvePack({
      staging,
      output: config.output,
      packId: config.packId,
      version: config.version,
    });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Adds authoritative schema-v2 metadata to a completed CVE staging database,
 * validates its exact manifest projection, and atomically publishes it.
 */
export async function publishBuiltCvePack(config: PublishBuiltCvePackConfig): Promise<void> {
  assertVersion(config.version);
  const staging = resolve(config.staging);
  const output = resolve(config.output);
  if (staging === output || pathsOverlap(staging, output)) {
    throw new Error('staging and output paths must not overlap');
  }
  assertSameFilesystem(output, staging);
  assertNoReplacePublicationAvailable();
  const metadata: DurablePackMetadata = {
    packId: config.packId,
    version: config.version,
    schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    adapterVersion: CVE_ADAPTER_VERSION,
    extractorVersion: CVE_ADAPTER_VERSION,
    toolVersion: UPDATE_TOOL_VERSION,
    buildId: buildIdFor({
      packId: config.packId,
      version: config.version,
      baseContentDigest: null,
      deltaId: null,
    }),
    provenance: PROVENANCE,
    basePackId: null,
    baseVersion: null,
    baseBuildId: null,
    baseContentDigest: null,
    deltaId: null,
    deltaFileSha256: null,
  };
  const database = new Database(join(staging, 'pack.db'), { autoCheckpoint: false });
  const connection = database.connect();
  try {
    const applications = await readUpdateApplications(connection);
    if (applications.length !== 0) {
      throw new Error('full CVE build must not contain incremental update applications');
    }
    const metadataRows = await connection.run<{ count: number | bigint }>(
      'MATCH (m:PackMetadata) RETURN count(m) AS count',
    );
    const metadataCount = Number(metadataRows[0]?.count ?? 0);
    if (metadataCount === 0) {
      await writePackMetadata(connection, metadata);
      await connection.run('CHECKPOINT');
    } else {
      const existing = await readPackMetadata(connection);
      if (canonical(existing) !== canonical(metadata)) {
        throw new Error('staged full-build metadata does not match authoritative build inputs');
      }
    }
  } finally {
    connection.close();
    database.close();
  }
  await finalizePack(staging, metadata);
  if (!publishDirectoryNoReplace(staging, output)) {
    throw new Error(`output collision: ${output} already exists`);
  }
  fsyncDirectory(dirname(output));
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

async function sourceHashesForPack(packDir: string): Promise<Map<string, string>> {
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

function applicationsFor(
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

function expectedSourceClosure(
  baseHashes: Map<string, string>,
  delta: DeltaRecord[],
): ArticleSourceIdentity[] {
  const hashes = new Map(baseHashes);
  for (const record of delta) hashes.set(record.key, record.payloadHash);
  return [...hashes]
    .map(([title, hash]) => ({ title, hash }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

async function sourceClosureForPack(packDir: string): Promise<ArticleSourceIdentity[]> {
  const database = new Database(join(packDir, 'pack.db'), { readOnly: true });
  const connection = database.connect();
  try {
    const rows = await connection.run<ArticleSourceIdentity>(
      'MATCH (s:ArticleSource) RETURN s.title AS title, s.payload_sha256 AS hash ORDER BY title',
    );
    const titles = new Set(rows.map((row) => row.title));
    if (titles.size !== rows.length) throw new Error('pack contains duplicate article sources');
    return rows;
  } finally {
    connection.close();
    database.close();
  }
}

async function expectedUpdateFor(
  state: UpdateState,
  parsed: ParsedDelta,
  baseValidation: PackValidationResult,
): Promise<ExpectedUpdate> {
  const buildId = buildIdFor({
    packId: baseValidation.metadata.packId,
    version: state.version,
    baseContentDigest: baseValidation.contentDigest,
    deltaId: parsed.deltaId,
  });
  if (state.buildId !== buildId) {
    throw new Error('update build ID does not match the current base, delta, and target version');
  }
  const baseHashes = await sourceHashesForPack(state.base);
  return {
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

async function assertPackMatchesExpected(
  packDir: string,
  validation: PackValidationResult,
  expected: ExpectedUpdate,
  message: string,
): Promise<void> {
  const sources = await sourceClosureForPack(packDir);
  if (
    canonical(validation.metadata) !== canonical(expected.metadata) ||
    canonical(validation.applications) !== canonical(expected.applications) ||
    canonical(sources) !== canonical(expected.sources)
  ) {
    throw new Error(message);
  }
}

function targetMetadata(
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
    provenance: PROVENANCE,
    basePackId: base.packId,
    baseVersion: base.version,
    baseBuildId: base.buildId,
    baseContentDigest: input.baseContentDigest,
    deltaId: input.deltaId,
    deltaFileSha256: input.deltaFileSha256,
  };
}

function resultFromValidation(
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

async function publishStagedPack(
  state: UpdateState,
  expected: ExpectedUpdate,
): Promise<UpdateKnowledgePackResult> {
  const staging = join(state.workDir, 'staging');
  if (!existsSync(staging) || !statSync(staging).isDirectory()) {
    throw new Error(`completed update staging directory is missing at ${staging}`);
  }
  const validation = await validateKnowledgePack(staging);
  await assertPackMatchesExpected(
    staging,
    validation,
    expected,
    'completed update staging does not match the current base-plus-delta state',
  );
  fsyncDirectory(state.workDir);
  await assertBaseUnchanged(state);
  if (!publishDirectoryNoReplace(staging, state.output)) {
    const existing = await validateKnowledgePack(state.output);
    await assertPackMatchesExpected(
      state.output,
      existing,
      expected,
      `output collision at ${state.output}`,
    );
    if (existing.contentDigest !== validation.contentDigest)
      throw new Error(`output collision at ${state.output}`);
    rmSync(state.workDir, { recursive: true, force: true });
    return resultFromValidation(state, existing, true);
  }
  fsyncDirectory(dirname(state.output));
  rmSync(state.workDir, { recursive: true, force: true });
  return resultFromValidation(state, validation, false);
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
  await connection.run('MATCH (n:PackMetadata) DELETE n');
}

async function executeUpdate(
  state: UpdateState,
  parsed: ParsedDelta,
  expected: ExpectedUpdate,
  embedder: Embedder,
  onCheckpoint?: (checkpoint: PackCheckpoint) => void,
): Promise<UpdateKnowledgePackResult> {
  if (state.phase === 'delta-applied') return publishStagedPack(state, expected);

  const baseDatabase = new Database(join(state.base, 'pack.db'), { readOnly: true });
  const baseConnection = baseDatabase.connect();
  let baseHashes: Map<string, string>;
  let baseMetadata: DurablePackMetadata;
  try {
    const sourceRows = await baseConnection.run<{ title: string; hash: string }>(
      'MATCH (s:ArticleSource) RETURN s.title AS title, s.payload_sha256 AS hash ORDER BY title',
    );
    baseHashes = new Map(sourceRows.map((row) => [row.title, row.hash]));
    baseMetadata = await readPackMetadata(baseConnection);
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
      if (loadedHashes.size !== loadedSources.length) {
        throw new Error('staged update contains duplicate article sources');
      }
      const expectedHashes = new Map(expected.sources.map((source) => [source.title, source.hash]));
      for (const source of loadedSources) {
        if (expectedHashes.get(source.title) !== source.hash) {
          throw new Error(
            `staged article source does not match the current base-plus-delta state: ${source.title}`,
          );
        }
      }
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
    const applications = applicationsFor(baseHashes, parsed.records);
    for (let offset = 0; offset < applications.length; offset += 500) {
      await outputConnection.run(
        'UNWIND $records AS r CREATE (:UpdateApplication {article_title: r.key, ' +
          'operation: r.operation, base_payload_sha256: r.basePayloadSha256, ' +
          'result_payload_sha256: r.resultPayloadSha256, classification: r.classification})',
        { records: applications.slice(offset, offset + 500) },
      );
    }
    const metadata = targetMetadata(baseMetadata, {
      version: state.version,
      buildId: state.buildId,
      baseContentDigest: state.baseContentDigest,
      deltaId: state.deltaId,
      deltaFileSha256: state.deltaFileSha256,
    });
    await writePackMetadata(outputConnection, metadata);
    if (applications.length > 0) {
      await outputConnection.run('CHECKPOINT');
    }
  } finally {
    outputConnection.close();
    outputDatabase.close();
    baseConnection.close();
    baseDatabase.close();
  }
  await finalizePack(
    staging,
    targetMetadata(baseMetadata, {
      version: state.version,
      buildId: state.buildId,
      baseContentDigest: state.baseContentDigest,
      deltaId: state.deltaId,
      deltaFileSha256: state.deltaFileSha256,
    }),
  );
  state.phase = 'delta-applied';
  state.records = state.records.map((record) => ({ ...record, processed: true }));
  writeState(state);
  onCheckpoint?.({ phase: state.phase, workDir: state.workDir });
  return publishStagedPack(state, expected);
}

/** Applies or resumes an immutable, provenance-aware CVE pack update. */
async function updateKnowledgePackInternal(
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
    const basePayload = await fileEntry(join(state.base, 'pack.db'), 'pack.db');
    if (
      baseValidation.contentDigest !== state.baseContentDigest ||
      sha256(readFileSync(join(state.base, 'manifest.json'))) !== state.baseManifestSha256 ||
      basePayload.sha256 !== state.basePayloadSha256
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
    assertNoReplacePublicationAvailable();
    const expected = await expectedUpdateFor(state, parsed, baseValidation);
    if (existsSync(state.output)) {
      if (!lstatSync(state.output).isDirectory()) {
        throw new Error(`output collision at ${state.output}`);
      }
      const completed = await validateKnowledgePack(state.output);
      await assertPackMatchesExpected(
        state.output,
        completed,
        expected,
        `output collision at ${state.output}`,
      );
      await assertBaseUnchanged(state);
      rmSync(state.workDir, { recursive: true, force: true });
      return resultFromValidation(state, completed, true);
    }
    return executeUpdate(
      state,
      parsed,
      expected,
      config.embedder ?? new BgeEmbedder(),
      config.onCheckpoint,
    );
  }

  assertVersion(config.version);
  const base = resolve(config.base);
  const deltaPath = resolve(config.delta);
  const output = resolve(config.output);
  if (base === output) throw new Error('output must be distinct from the base pack');
  const parsed = readDelta(deltaPath);
  const baseValidation = await validateKnowledgePack(base);
  const baseMetadata = baseValidation.metadata;
  if (config.version === baseMetadata.version) {
    throw new Error('target version must differ from the base version');
  }
  if (
    baseMetadata.schemaVersion !== INCREMENTAL_SCHEMA_VERSION ||
    baseMetadata.adapterVersion !== CVE_ADAPTER_VERSION ||
    baseMetadata.extractorVersion !== CVE_ADAPTER_VERSION
  ) {
    throw new Error('base pack is not provenance-capable and must be rebuilt from source');
  }
  const packId = baseMetadata.packId;
  const buildId = buildIdFor({
    packId,
    version: config.version,
    baseContentDigest: baseValidation.contentDigest,
    deltaId: parsed.deltaId,
  });
  const workDir = resolve(config.workDir ?? `${output}.work`);
  assertDisjointPaths(base, output, workDir);
  assertSameFilesystem(output, workDir);
  assertNoReplacePublicationAvailable();
  if (existsSync(workDir)) {
    throw new Error(`incomplete update work exists at ${workDir}; use --resume ${workDir}`);
  }
  const basePayload = await fileEntry(join(base, 'pack.db'), 'pack.db');
  const state: UpdateState = {
    phase: 'prepared',
    base,
    delta: deltaPath,
    output,
    version: config.version,
    buildId,
    deltaId: parsed.deltaId,
    deltaFileSha256: parsed.fileSha256,
    baseContentDigest: baseValidation.contentDigest,
    baseManifestSha256: sha256(readFileSync(join(base, 'manifest.json'))),
    basePayloadSha256: basePayload.sha256,
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
  const expected = await expectedUpdateFor(state, parsed, baseValidation);
  if (existsSync(output)) {
    if (lstatSync(output).isDirectory()) {
      const existing = await validateKnowledgePack(output);
      const existingSources = await sourceClosureForPack(output);
      if (
        canonical(existing.metadata) === canonical(expected.metadata) &&
        canonical(existing.applications) === canonical(expected.applications) &&
        canonical(existingSources) === canonical(expected.sources)
      ) {
        const noOpState = { output };
        return resultFromValidation(noOpState, existing, true);
      }
    }
    throw new Error(`output collision: ${output} already exists`);
  }
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(dirname(workDir), { recursive: true });
  try {
    mkdirSync(workDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`incomplete update work exists at ${workDir}; use --resume ${workDir}`);
    }
    throw error;
  }
  writeState(state);
  return executeUpdate(
    state,
    parsed,
    expected,
    config.embedder ?? new BgeEmbedder(),
    config.onCheckpoint,
  );
}

export async function updateKnowledgePack(
  config: UpdateKnowledgePackConfig,
): Promise<UpdateKnowledgePackResult> {
  try {
    return await updateKnowledgePackInternal(config);
  } catch (error) {
    if (error instanceof KnowledgePackUpdateError) throw error;
    throw new KnowledgePackUpdateError(error instanceof Error ? error.message : String(error));
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
    if (
      metadata.packId === '' ||
      metadata.version === '' ||
      metadata.schemaVersion !== INCREMENTAL_SCHEMA_VERSION ||
      metadata.adapterVersion !== CVE_ADAPTER_VERSION ||
      metadata.extractorVersion !== CVE_ADAPTER_VERSION ||
      metadata.toolVersion !== UPDATE_TOOL_VERSION ||
      !SHA256_RE.test(metadata.buildId) ||
      canonical(metadata.provenance) !== canonical(PROVENANCE)
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
        !/^CVE-\d{4}-\d+$/.test(application.key) ||
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
