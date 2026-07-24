import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { canonicalJson } from './canonical-json.js';
import { CVE_ID_RE, cveToGraph } from './cve-adapter.js';

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

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
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
      if (
        canonicalJson(keys) !== canonicalJson(['key', 'operation', 'payload']) ||
        !object.payload
      ) {
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
    const payload = canonicalJson(payloadObject);
    const metadataObject =
      metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
    if (String(metadataObject.state ?? '').toUpperCase() === 'REJECTED') {
      throw new Error(`delete operation is not supported (${key} is REJECTED)`);
    }
    let graph;
    try {
      graph = cveToGraph(payloadObject);
    } catch (error) {
      throw new Error(`invalid delta record ${ordinal + 1}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    if (!graph) {
      throw new Error(`delta record ${ordinal + 1} cannot be mapped by the CVE adapter`);
    }
    records.push({ ordinal, key, payload, payloadHash: sha256(payload) });
    ordinal++;
  }
  records.sort((left, right) => left.key.localeCompare(right.key));
  const deltaId = sha256(
    canonicalJson(
      records.map((record) => ({
        operation: 'upsert',
        key: record.key,
        sourcePayloadSha256: record.payloadHash,
      })),
    ),
  );
  return { records, deltaId, fileSha256: sha256(bytes) };
}
