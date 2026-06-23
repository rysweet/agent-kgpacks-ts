// Lenient manifest reader — a faithful port of the upstream `_load_manifest`.
//
// Unlike `@kgpacks/packs`' `loadManifestFromDir` (which strictly validates the
// schema and throws), the MCP server reads manifests leniently so its output
// matches the upstream server byte-for-byte: a missing `manifest.json` yields a
// `{ name, error }` stand-in, and a present file is returned exactly as parsed
// (no schema validation). The `manifest.json` filename is reused from
// `@kgpacks/packs` so the on-disk convention has a single source of truth.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { MANIFEST_FILENAME } from '@kgpacks/packs';

/** A manifest as read from disk, before any schema validation. */
export type RawManifest = Record<string, unknown>;

/**
 * Reads `<packDir>/manifest.json` leniently.
 *
 * Mirrors the upstream `_load_manifest`: when the file is absent it returns
 * `{ name: <dir basename>, error: 'manifest.json missing' }`; otherwise it
 * returns the parsed JSON unchanged. A malformed `manifest.json` propagates the
 * `JSON.parse` error, exactly as the upstream `json.loads` would raise.
 */
export function loadManifestLenient(packDir: string): RawManifest {
  const manifestPath = join(packDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    return { name: basename(packDir), error: 'manifest.json missing' };
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as RawManifest;
}
