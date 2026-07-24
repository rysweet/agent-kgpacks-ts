import { createHash } from 'node:crypto';

import { isValidSemver, type PackManifest } from '@kgpacks/packs';

import { CVE_ADAPTER_VERSION } from './cve-adapter.js';
import type { Embedder } from './types.js';

export const INCREMENTAL_SCHEMA_VERSION = '2';
export const UPDATE_TOOL_VERSION = 'agent-kgpacks-ts@0.1.0';
export const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA1_RE = /^[a-f0-9]{40}$/;
export const STATE_FILE = 'update-state.json';
export const METADATA_ID = 'pack';
export const provenanceFor = (
  embeddingModel: string,
  corpusCommit: string,
  corpusDate: string,
  corpusTag: string | null = null,
) => ({
  corpus: { name: 'cvelistV5', commit: corpusCommit, date: corpusDate, tag: corpusTag },
  embedding: { model: embeddingModel, dimensions: 768 },
  build: { tool_version: UPDATE_TOOL_VERSION },
});

export interface DeltaRecord {
  ordinal: number;
  key: string;
  payload: string;
  payloadHash: string;
}

export interface ParsedDelta {
  records: DeltaRecord[];
  deltaId: string;
  fileSha256: string;
}

export interface UpdateState {
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
  embeddingModel: string;
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
  corpusCommit: string;
  corpusDate: string;
  corpusTag?: string | null;
}

export interface PublishBuiltCvePackConfig {
  staging: string;
  output: string;
  packId: string;
  version: string;
  embeddingModelId?: string;
  corpusCommit: string;
  corpusDate: string;
  corpusTag?: string | null;
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

export interface ArticleSourceIdentity {
  title: string;
  hash: string;
}

export interface ExpectedUpdate {
  baseMetadata: DurablePackMetadata;
  metadata: DurablePackMetadata;
  applications: DurableUpdateApplication[];
  sources: ArticleSourceIdentity[];
  baseHashes: Map<string, string>;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareUnicodeScalars(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex) ?? 0;
    const rightPoint = right.codePointAt(rightIndex) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  if (leftIndex < left.length) return 1;
  if (rightIndex < right.length) return -1;
  return 0;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareUnicodeScalars)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

export function embedderModelId(embedder: Embedder): string {
  const modelId = embedder.modelId?.trim();
  if (!modelId) {
    throw new Error('incremental knowledge-pack embedders must declare a stable modelId');
  }
  return modelId;
}

export function provenanceEmbeddingModel(provenance: Record<string, unknown>): string | null {
  const embedding = provenance.embedding;
  if (!embedding || typeof embedding !== 'object' || Array.isArray(embedding)) return null;
  const model = (embedding as Record<string, unknown>).model;
  const dimensions = (embedding as Record<string, unknown>).dimensions;
  return typeof model === 'string' && model !== '' && dimensions === 768 ? model : null;
}

export function hasCanonicalProvenance(
  provenance: Record<string, unknown>,
  embeddingModel: string,
): boolean {
  const corpus = provenance.corpus;
  if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus)) return false;
  const { commit, date, tag } = corpus as Record<string, unknown>;
  if (
    typeof commit !== 'string' ||
    !GIT_SHA1_RE.test(commit) ||
    typeof date !== 'string' ||
    !isRealUtcDate(date) ||
    (tag !== null && (typeof tag !== 'string' || tag === ''))
  ) {
    return false;
  }
  return (
    canonical(provenance) ===
    canonical(provenanceFor(embeddingModel, commit, date, tag as string | null))
  );
}

function isRealUtcDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

export function assertCorpusProvenance(commit: string, date: string, tag: string | null): void {
  if (!GIT_SHA1_RE.test(commit)) {
    throw new Error('corpus commit must be a full lowercase 40-character Git SHA-1');
  }
  if (!isRealUtcDate(date)) {
    throw new Error('corpus date must be a real UTC calendar date in YYYY-MM-DD form');
  }
  if (tag !== null && tag === '') throw new Error('corpus tag must be non-empty when provided');
}

export function assertScalarStrings(value: unknown, location: string): void {
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

export function assertVersion(version: string): void {
  if (!isValidSemver(version)) {
    throw new Error(`invalid target version ${JSON.stringify(version)}`);
  }
}

export function validatedPackDbSha256(validation: PackValidationResult): string {
  const files = validation.manifest.files;
  if (
    !Array.isArray(files) ||
    files.length !== 1 ||
    !files[0] ||
    typeof files[0] !== 'object' ||
    (files[0] as Record<string, unknown>).path !== 'pack.db' ||
    typeof (files[0] as Record<string, unknown>).sha256 !== 'string'
  ) {
    throw new Error('validated pack manifest is missing its pack.db checksum');
  }
  return (files[0] as Record<string, string>).sha256;
}

export function contentDigest(
  files: Array<{ path: string; size: number; sha256: string }>,
): string {
  return sha256(
    canonical([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
  );
}

export function buildIdFor(input: {
  packId: string;
  version: string;
  baseContentDigest: string | null;
  deltaId: string | null;
  embeddingModel: string;
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
