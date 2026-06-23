// Packs-directory resolution.
//
// Resolves the directory the server scans for installed packs. Mirrors the
// upstream `PACKS_DIR = <repo>/data/packs` default while adding a
// `KGPACKS_PACKS_DIR` environment override so the stdio entry point can be
// pointed at any install root without code changes.

import { join } from 'node:path';

import { PACKS_DIR_ENV } from './constants.js';

/**
 * Resolves the default packs directory.
 *
 * Returns the `KGPACKS_PACKS_DIR` override when set to a non-empty value,
 * otherwise `<cwd>/data/packs` (the upstream server's relative layout; the
 * documented VS Code / Claude Desktop configs set `cwd` to the repo root).
 */
export function resolveDefaultPacksDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const override = env[PACKS_DIR_ENV];
  if (typeof override === 'string' && override.trim() !== '') {
    return override;
  }
  return join(cwd, 'data', 'packs');
}
