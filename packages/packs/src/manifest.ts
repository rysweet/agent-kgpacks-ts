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
  node_count: number;
  edge_count: number;
  [extra: string]: number;
}

export interface EvalScores {
  [metric: string]: number;
}

export interface PackManifest {
  name: string;
  version: string;
  description?: string;
  graph_stats?: GraphStats;
  eval_scores?: EvalScores;
  [extra: string]: unknown;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function validateGraphStats(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new ManifestValidationError('graph_stats must be an object');
  }
  for (const key of ['node_count', 'edge_count'] as const) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new ManifestValidationError(`graph_stats.${key} must be a non-negative integer`);
    }
  }
  for (const [key, n] of Object.entries(value)) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new ManifestValidationError(`graph_stats.${key} must be a finite number`);
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
      `invalid version ${JSON.stringify(version)} (must be valid SemVer 2.0)`,
    );
  }
  if ('description' in value && typeof value.description !== 'string') {
    throw new ManifestValidationError('description must be a string');
  }
  if (value.graph_stats !== undefined) validateGraphStats(value.graph_stats);
  if (value.eval_scores !== undefined) validateEvalScores(value.eval_scores);

  // Rebuild without dangerous keys to guard against prototype pollution from
  // untrusted manifest JSON, while preserving every other (unknown) key.
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    result[key] = value[key];
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
