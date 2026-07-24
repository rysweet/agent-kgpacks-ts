import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';
import { CVE_ADAPTER_VERSION } from './cve-adapter.js';

export const INCREMENTAL_SCHEMA_VERSION = '2';
export const UPDATE_TOOL_VERSION = 'agent-kgpacks-ts@0.1.0';

export interface IncrementalBuildIdentity {
  packId: string;
  version: string;
  baseContentDigest: string | null;
  deltaId: string | null;
  embeddingModel: string;
}

/** Derives the immutable build identity from every output-affecting input. */
export function buildIdFor(input: IncrementalBuildIdentity): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        ...input,
        schemaVersion: INCREMENTAL_SCHEMA_VERSION,
        adapterVersion: CVE_ADAPTER_VERSION,
        extractorVersion: CVE_ADAPTER_VERSION,
        toolVersion: UPDATE_TOOL_VERSION,
      }),
    )
    .digest('hex');
}
