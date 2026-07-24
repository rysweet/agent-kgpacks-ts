import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { isValidSemver } from '@kgpacks/packs';

import { CVE_ID_RE } from './cve-adapter.js';
import { fsyncDirectory, fsyncFile } from './incremental-publication.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const STATE_FILE = 'update-state.json';

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
  baseProvenanceSha256: string;
  workDir: string;
  schemaVersion: string;
  extractorVersion: string;
  toolVersion: string;
  embeddingModel: string;
  records: Array<{ ordinal: number; key: string; hash: string; processed: boolean }>;
}

export function writeState(state: UpdateState): void {
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
    'baseProvenanceSha256',
    'workDir',
    'schemaVersion',
    'extractorVersion',
    'toolVersion',
    'embeddingModel',
  ] as const;
  if (strings.some((key) => typeof state[key] !== 'string' || state[key] === '')) {
    throw new Error(`invalid update resume state at ${path}`);
  }
  if (
    (state.phase !== 'prepared' && state.phase !== 'delta-applied') ||
    !isValidSemver(String(state.version)) ||
    ![
      state.buildId,
      state.deltaId,
      state.deltaFileSha256,
      state.baseContentDigest,
      state.baseManifestSha256,
      state.basePayloadSha256,
      state.baseProvenanceSha256,
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
      !CVE_ID_RE.test(item.key) ||
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

export function readState(workDir: string): UpdateState {
  const path = join(resolve(workDir), STATE_FILE);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read update resume state at ${path}: ${(error as Error).message}`);
  }
  return asUpdateState(value, path);
}
