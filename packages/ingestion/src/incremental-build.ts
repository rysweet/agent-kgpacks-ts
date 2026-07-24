import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { Database } from '@kgpacks/db';
import { BGE_MODEL_ID } from '@kgpacks/embeddings';
import { saveManifest } from '@kgpacks/packs';

import { CVE_ADAPTER_VERSION } from './cve-adapter.js';
import { readDelta } from './incremental-delta.js';
import {
  assertNoReplacePublicationAvailable,
  assertSameFilesystem,
  fileEntry,
  fsyncDirectory,
  fsyncFile,
  nearestExisting,
  pathsOverlap,
  publishDirectoryNoReplace,
} from './incremental-files.js';
import {
  createManifest,
  databaseCounts,
  readPackMetadata,
  readUpdateApplications,
  toLoadable,
  writeDatabase,
  writePackMetadata,
} from './incremental-pack.js';
import {
  INCREMENTAL_SCHEMA_VERSION,
  UPDATE_TOOL_VERSION,
  assertCorpusProvenance,
  assertVersion,
  buildIdFor,
  canonical,
  embedderModelId,
  provenanceFor,
  type BuildCvePackConfig,
  type DurablePackMetadata,
  type DurableUpdateApplication,
  type PackValidationResult,
  type PublishBuiltCvePackConfig,
} from './incremental-shared.js';
import { validateKnowledgePack } from './incremental-validation.js';

export async function finalizePack(
  staging: string,
  metadata: DurablePackMetadata,
): Promise<PackValidationResult> {
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
  const validation = await validateKnowledgePack(staging);
  fsyncFile(join(staging, 'pack.db'));
  fsyncFile(join(staging, 'manifest.json'));
  fsyncDirectory(staging);
  fsyncDirectory(dirname(staging));
  return validation;
}

/** Builds a small provenance-capable CVE pack from an NDJSON corpus. */
export async function buildCvePack(config: BuildCvePackConfig): Promise<void> {
  assertVersion(config.version);
  assertCorpusProvenance(config.corpusCommit, config.corpusDate, config.corpusTag ?? null);
  if (existsSync(config.output)) throw new Error(`output already exists: ${config.output}`);
  const parsed = readDelta(config.source);
  assertNoReplacePublicationAvailable(nearestExisting(dirname(resolve(config.output))));
  const embeddingModel = embedderModelId(config.embedder);
  const buildId = buildIdFor({
    packId: config.packId,
    version: config.version,
    baseContentDigest: null,
    deltaId: null,
    embeddingModel,
  });
  const metadata: DurablePackMetadata = {
    packId: config.packId,
    version: config.version,
    schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    adapterVersion: CVE_ADAPTER_VERSION,
    extractorVersion: CVE_ADAPTER_VERSION,
    toolVersion: UPDATE_TOOL_VERSION,
    buildId,
    provenance: provenanceFor(
      embeddingModel,
      config.corpusCommit,
      config.corpusDate,
      config.corpusTag ?? null,
    ),
    basePackId: null,
    baseVersion: null,
    baseBuildId: null,
    baseContentDigest: null,
    deltaId: null,
    deltaFileSha256: null,
  };
  const output = resolve(config.output);
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(
    join(dirname(output), `.${basename(output)}.build-${buildId.slice(0, 12)}-`),
  );
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
      embeddingModelId: embeddingModel,
      corpusCommit: config.corpusCommit,
      corpusDate: config.corpusDate,
      corpusTag: config.corpusTag,
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
  assertCorpusProvenance(config.corpusCommit, config.corpusDate, config.corpusTag ?? null);
  const staging = resolve(config.staging);
  const output = resolve(config.output);
  if (staging === output || pathsOverlap(staging, output)) {
    throw new Error('staging and output paths must not overlap');
  }
  assertSameFilesystem(output, staging);
  assertNoReplacePublicationAvailable(nearestExisting(dirname(staging)));
  const embeddingModel = config.embeddingModelId ?? BGE_MODEL_ID;
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
      embeddingModel,
    }),
    provenance: provenanceFor(
      embeddingModel,
      config.corpusCommit,
      config.corpusDate,
      config.corpusTag ?? null,
    ),
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
