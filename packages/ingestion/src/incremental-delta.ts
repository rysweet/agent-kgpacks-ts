import { isAbsolute, join, resolve } from 'node:path';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { isValidSemver } from '@kgpacks/packs';

import { CVE_ID_RE, cveToGraph } from './cve-adapter.js';
import { fsyncDirectory, fsyncFile } from './incremental-files.js';
import {
  SHA256_RE,
  STATE_FILE,
  assertScalarStrings,
  canonical,
  sha256,
  type DeltaRecord,
  type ParsedDelta,
  type UpdateState,
} from './incremental-shared.js';

export function readDelta(path: string): ParsedDelta {
  const bytes = readFileSync(path);
  const records: DeltaRecord[] = [];
  const seen = new Set<string>();
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('delta is not valid UTF-8');
  }
  let ordinal = 0;
  let lineStart = 0;
  while (lineStart <= decoded.length) {
    const newline = decoded.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? decoded.length : newline;
    const contentEnd =
      lineEnd > lineStart && decoded.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    const raw = decoded.slice(lineStart, contentEnd);
    lineStart = newline === -1 ? decoded.length + 1 : newline + 1;
    if (raw.trim() === '') continue;
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
    if (!CVE_ID_RE.test(key)) {
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
    ordinal++;
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
