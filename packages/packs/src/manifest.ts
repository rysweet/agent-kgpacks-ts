// Pack manifest model + validation (ports the upstream manifest module).
//
// The on-disk format is the unchanged `manifest.json` with snake_case keys, so
// packs written by the upstream tooling load byte-for-byte. Validation is
// the single schema gate the rest of the package calls; it throws on any
// violation and strips prototype-pollution keys when rebuilding the result.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ManifestValidationError } from './errors.js';
import { isValidSemver } from './versioning.js';

export const MANIFEST_FILENAME = 'manifest.json';

// Ported verbatim from the upstream source: 1–64 chars, alphanumeric lead, then
// ASCII letters/digits/underscore/hyphen. Anchored + bounded ⇒ ReDoS-safe.
export const PACK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface GraphStats {
  /** Article (node) count — present in real catalog/built-pack manifests. */
  articles?: number;
  /** Distinct entity count. */
  entities?: number;
  /** Entity→entity relationship count. */
  relationships?: number;
  /** On-disk pack size in megabytes. */
  size_mb?: number;
  /** Any additional numeric stat is tolerated (must be a non-negative number). */
  [stat: string]: number | undefined;
}

export interface EvalScores {
  [metric: string]: number;
}

/**
 * Build provenance: where a published pack came from. Written into `manifest.json`
 * and mirrored in `<name>.pack-release.json` so a pack can be audited/reproduced.
 * Every declared string field is optional; an undeterminable value is recorded as
 * the string `"unknown"` (or `null`) rather than omitted, so the shape is stable.
 */
export interface PackProvenance {
  /** Source corpus the records were built from (e.g. cvelistV5 @ a commit). */
  corpus?: {
    name?: string;
    commit?: string | null;
    date?: string | null;
    tag?: string | null;
    [k: string]: unknown;
  };
  /** Embedding model used to embed every record (deterministic). */
  embedding?: { model?: string; dimensions?: number; [k: string]: unknown };
  /** Builder identity + when the pack was produced (UTC ISO-8601). */
  build?: { date?: string; tool_version?: string; [k: string]: unknown };
  [section: string]: unknown;
}

export interface PackManifest {
  name: string;
  version: string;
  description?: string;
  graph_stats?: GraphStats;
  eval_scores?: EvalScores;
  provenance?: PackProvenance;
  [extra: string]: unknown;
}

export type Sha256 = string;
export type UpdateOperation = 'upsert';
export type UpdateClassification = 'added' | 'modified' | 'unchanged';

export interface PackUpdateRecordV2 {
  key: string;
  operation: UpdateOperation;
  basePayloadSha256: Sha256 | null;
  resultPayloadSha256: Sha256;
  classification: UpdateClassification;
}

export interface PackUpdateV2 {
  added: number;
  modified: number;
  unchanged: number;
  records: PackUpdateRecordV2[];
}

export type PackLineageV2 =
  | { base: null; delta: null }
  | {
      base: {
        packId: string;
        version: string;
        buildId: Sha256;
        contentDigest: Sha256;
      };
      delta: { deltaId: Sha256; fileSha256: Sha256 };
    };

export interface PackFileMetadataV2 {
  path: string;
  size: number;
  sha256: Sha256;
}

export interface PackManifestV2 extends PackManifest {
  packId: string;
  schemaVersion: '2';
  adapterVersion: string;
  extractorVersion: string;
  toolVersion: string;
  buildId: Sha256;
  lineage: PackLineageV2;
  update: PackUpdateV2;
  files: PackFileMetadataV2[];
  contentDigest: Sha256;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deep-copies a value, dropping prototype-pollution keys at every level. */
function deepSanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSanitize);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      out[key] = deepSanitize(value[key]);
    }
    return out;
  }
  return value;
}

// Declared string fields per provenance section. Present values must be strings
// (or null/absent for undeterminable ones); anything else is a hard error.
const PROVENANCE_STRING_FIELDS: Record<string, readonly string[]> = {
  corpus: ['name', 'commit', 'date', 'tag'],
  embedding: ['model'],
  build: ['date', 'tool_version'],
};

function validateProvenance(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new ManifestValidationError('provenance must be an object');
  }
  for (const [section, fields] of Object.entries(PROVENANCE_STRING_FIELDS)) {
    const sec = value[section];
    if (sec == null) continue;
    if (!isPlainObject(sec)) {
      throw new ManifestValidationError(`provenance.${section} must be an object`);
    }
    for (const field of fields) {
      const fieldValue = sec[field];
      if (fieldValue == null) continue; // undeterminable → null/absent is allowed
      if (typeof fieldValue !== 'string') {
        throw new ManifestValidationError(`provenance.${section}.${field} must be a string`);
      }
    }
  }
  const embedding = value.embedding;
  if (isPlainObject(embedding) && embedding.dimensions != null) {
    const dimensions = embedding.dimensions;
    if (typeof dimensions !== 'number' || !Number.isFinite(dimensions) || dimensions < 0) {
      throw new ManifestValidationError(
        'provenance.embedding.dimensions must be a non-negative finite number',
      );
    }
  }
}

function validateGraphStats(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new ManifestValidationError('graph_stats must be an object');
  }
  // Real packs carry { articles, entities, relationships, size_mb }; no specific
  // key is required (the historical node_count/edge_count shape was never produced
  // by this platform). Every present stat must simply be a non-negative finite
  // number — counts are integers, size_mb is a float, so integrality is not required.
  for (const [key, n] of Object.entries(value)) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      throw new ManifestValidationError(`graph_stats.${key} must be a non-negative finite number`);
    }
  }
}

function validateEvalScores(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new ManifestValidationError('eval_scores must be an object');
  }
  for (const [key, n] of Object.entries(value)) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new ManifestValidationError(`eval_scores.${key} must be a finite number`);
    }
  }
}

export function validateManifest(value: unknown): PackManifest {
  if (!isPlainObject(value)) {
    throw new ManifestValidationError('manifest must be a JSON object');
  }

  const { name, version } = value;
  if (typeof name !== 'string' || !PACK_NAME_RE.test(name)) {
    throw new ManifestValidationError(
      `invalid pack name ${JSON.stringify(name)} (must match PACK_NAME_RE)`,
    );
  }
  if (typeof version !== 'string' || !isValidSemver(version)) {
    throw new ManifestValidationError(
      `invalid version ${JSON.stringify(version)} (must be SemVer 2.0)`,
    );
  }
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== '1' &&
    value.schemaVersion !== '2'
  ) {
    throw new ManifestValidationError(
      `unsupported schema version ${JSON.stringify(value.schemaVersion)}`,
    );
  }
  if ('description' in value && typeof value.description !== 'string') {
    throw new ManifestValidationError('description must be a string');
  }
  // Optional sections may be present-but-null in externally generated manifests;
  // treat null the same as absent (real catalog manifests carry `eval_scores: null`).
  if (value.graph_stats != null) validateGraphStats(value.graph_stats);
  if (value.eval_scores != null) validateEvalScores(value.eval_scores);
  if (value.provenance != null) validateProvenance(value.provenance);

  // Rebuild without dangerous keys to guard against prototype pollution from
  // untrusted manifest JSON, while preserving every other (unknown) key. The
  // provenance block is nested, so it is sanitized recursively.
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    result[key] = key === 'provenance' ? deepSanitize(value[key]) : value[key];
  }
  return result as PackManifest;
}

export function loadManifest(manifestPath: string): PackManifest {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new ManifestValidationError(
      `cannot read manifest at ${manifestPath}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ManifestValidationError(
      `manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return validateManifest(parsed);
}

export function loadManifestFromDir(packDir: string): PackManifest {
  return loadManifest(join(packDir, MANIFEST_FILENAME));
}

export function saveManifest(manifestPath: string, manifest: PackManifest): void {
  const valid = validateManifest(manifest);
  writeFileSync(manifestPath, JSON.stringify(valid, null, 2) + '\n');
}
