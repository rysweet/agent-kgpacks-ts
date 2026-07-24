import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Database, type Connection } from '@kgpacks/db';
import { BgeEmbedder } from '@kgpacks/embeddings';

import { CVE_ADAPTER_VERSION } from './cve-adapter.js';
import { KnowledgePackUpdateError } from './errors.js';
import { finalizePack } from './incremental-build.js';
import { readDelta, readState, writeState } from './incremental-delta.js';
import {
  assertDisjointPaths,
  assertNoReplacePublicationAvailable,
  assertSameFilesystem,
  fileEntry,
  fsyncDirectory,
  nearestExisting,
  publishDirectoryNoReplace,
} from './incremental-files.js';
import {
  applicationsEqual,
  applicationsFor,
  assertPackMatchesExpected,
  expectedUpdateFor,
  readBaseLoadables,
  resumeRecordsMatchDelta,
  resultFromValidation,
  sourceClosureForPack,
  sourceClosuresEqual,
  targetMetadata,
  toLoadable,
  writePackMetadata,
} from './incremental-pack.js';
import { createPackWriter } from './streaming-loader.js';
import {
  INCREMENTAL_SCHEMA_VERSION,
  UPDATE_TOOL_VERSION,
  assertVersion,
  buildIdFor,
  canonical,
  embedderModelId,
  provenanceEmbeddingModel,
  sha256,
  validatedPackDbSha256,
  type ExpectedUpdate,
  type PackCheckpoint,
  type PackValidationResult,
  type ParsedDelta,
  type UpdateKnowledgePackConfig,
  type UpdateKnowledgePackResult,
  type UpdateState,
} from './incremental-shared.js';
import type { Embedder } from './types.js';
import { validateKnowledgePack } from './incremental-validation.js';

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

async function publishStagedPack(
  state: UpdateState,
  expected: ExpectedUpdate,
  finalizedValidation?: PackValidationResult,
): Promise<UpdateKnowledgePackResult> {
  const staging = join(state.workDir, 'staging');
  if (!existsSync(staging) || !statSync(staging).isDirectory()) {
    throw new Error(`completed update staging directory is missing at ${staging}`);
  }
  const validation = finalizedValidation ?? (await validateKnowledgePack(staging));
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
  for (const [match, remove] of [
    [
      'MATCH ()-[r:ENTITY_RELATION]->() RETURN r LIMIT 1',
      'MATCH ()-[r:ENTITY_RELATION]->() DELETE r',
    ],
    ['MATCH ()-[r:LINKS_TO]->() RETURN r LIMIT 1', 'MATCH ()-[r:LINKS_TO]->() DELETE r'],
    ['MATCH (n:UpdateApplication) RETURN n LIMIT 1', 'MATCH (n:UpdateApplication) DELETE n'],
    ['MATCH (n:PackMetadata) RETURN n LIMIT 1', 'MATCH (n:PackMetadata) DELETE n'],
  ] as const) {
    if ((await connection.run(match)).length > 0) await connection.run(remove);
  }
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
  const baseHashes = expected.baseHashes;
  const baseMetadata = expected.baseMetadata;

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
    const checkpoints = new Map(state.records.map((record) => [record.key, record]));
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
    const finalTitles = [...baseHashes.keys()];
    for (const title of deltaByKey.keys()) {
      if (!baseHashes.has(title)) finalTitles.push(title);
    }
    finalTitles.sort();
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
        const checkpoint = checkpoints.get(title);
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
  const finalizedValidation = await finalizePack(
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
  return publishStagedPack(state, expected, finalizedValidation);
}

/** Applies or resumes an immutable, provenance-aware CVE pack update. */
async function updateKnowledgePackInternal(
  config: UpdateKnowledgePackConfig,
): Promise<UpdateKnowledgePackResult> {
  if ('resume' in config) {
    const state = readState(config.resume);
    const embedder = config.embedder ?? new BgeEmbedder();
    if (embedderModelId(embedder) !== state.embeddingModel) {
      throw new Error('embedding model changed since the interrupted update');
    }
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
      baseValidation.contentDigest !== state.baseContentDigest ||
      sha256(readFileSync(join(state.base, 'manifest.json'))) !== state.baseManifestSha256 ||
      validatedPackDbSha256(baseValidation) !== state.basePayloadSha256
    ) {
      throw new Error('base input changed since the interrupted update');
    }
    const parsed = readDelta(state.delta);
    if (parsed.fileSha256 !== state.deltaFileSha256 || parsed.deltaId !== state.deltaId) {
      throw new Error('delta input changed since the interrupted update');
    }
    if (
      !resumeRecordsMatchDelta(state.records, parsed.records) ||
      (state.phase === 'delta-applied' && state.records.some((record) => !record.processed))
    ) {
      throw new Error('update resume record checkpoints do not match the delta');
    }
    assertNoReplacePublicationAvailable(nearestExisting(dirname(state.output)));
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
    return executeUpdate(state, parsed, expected, embedder, config.onCheckpoint);
  }

  assertVersion(config.version);
  const base = resolve(config.base);
  const deltaPath = resolve(config.delta);
  const output = resolve(config.output);
  if (base === output) throw new Error('output must be distinct from the base pack');
  const parsed = readDelta(deltaPath);
  const baseValidation = await validateKnowledgePack(base);
  const baseMetadata = baseValidation.metadata;
  const embedder = config.embedder ?? new BgeEmbedder();
  const embeddingModel = embedderModelId(embedder);
  const baseEmbeddingModel = provenanceEmbeddingModel(baseMetadata.provenance);
  if (baseEmbeddingModel !== embeddingModel) {
    throw new Error(
      `embedding model ${JSON.stringify(embeddingModel)} does not match base pack model ${JSON.stringify(baseEmbeddingModel)}`,
    );
  }
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
    embeddingModel,
  });
  const workDir = resolve(config.workDir ?? `${output}.work`);
  assertDisjointPaths(base, output, workDir);
  assertSameFilesystem(output, workDir);
  assertNoReplacePublicationAvailable(nearestExisting(dirname(output)));
  if (existsSync(workDir)) {
    throw new Error(`incomplete update work exists at ${workDir}; use --resume ${workDir}`);
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
    baseContentDigest: baseValidation.contentDigest,
    baseManifestSha256: sha256(readFileSync(join(base, 'manifest.json'))),
    basePayloadSha256: validatedPackDbSha256(baseValidation),
    workDir,
    schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    extractorVersion: CVE_ADAPTER_VERSION,
    toolVersion: UPDATE_TOOL_VERSION,
    embeddingModel,
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
        applicationsEqual(existing.applications, expected.applications) &&
        sourceClosuresEqual(existingSources, expected.sources)
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
  return executeUpdate(state, parsed, expected, embedder, config.onCheckpoint);
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
