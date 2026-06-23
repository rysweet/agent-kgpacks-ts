// Path-safe pack-directory resolution shared by `query` and `pack validate`.
//
// The pack name is validated against `PACK_NAME_RE` BEFORE any path is built, so
// a traversal attempt can never escape the packs directory. An invalid name and
// a missing directory are reported identically (a `PackNotFoundError`-equivalent
// CLI error → exit 3), matching the `@kgpacks/mcp` resolver.

import { statSync } from 'node:fs';
import { join } from 'node:path';

import { PACK_NAME_RE } from '@kgpacks/packs';

import { CliError } from './errors.js';
import { EXIT_PACK_NOT_FOUND } from './exit-codes.js';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Resolves `<packsDir>/<name>`, throwing a not-found CLI error if absent. */
export function resolveExistingPackDir(packsDir: string, name: string): string {
  if (!PACK_NAME_RE.test(name)) {
    throw new CliError(`pack not found: ${name}`, EXIT_PACK_NOT_FOUND);
  }
  const dir = join(packsDir, name);
  if (!isDirectory(dir)) {
    throw new CliError(`pack not found: ${name}`, EXIT_PACK_NOT_FOUND);
  }
  return dir;
}
