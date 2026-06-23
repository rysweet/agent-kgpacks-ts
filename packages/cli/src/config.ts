// Packs-directory resolution.
//
// Resolves the install root the CLI reads/writes packs under. Precedence mirrors
// the frozen design: the explicit `--packs-dir` flag wins, then a programmatic
// injection (used by tests and embedders), then the `KGPACKS_PACKS_DIR`
// environment override, and finally `<cwd>/data/packs` (the upstream relative
// layout shared with `@kgpacks/mcp`).

import { join } from 'node:path';

import { PACKS_DIR_ENV } from './constants.js';

/** Inputs to {@link resolvePacksDir}, in descending precedence. */
export interface ResolvePacksDirOptions {
  /** Value of the global `--packs-dir` flag, if provided. */
  flag?: string;
  /** Programmatic override (test/embedder injection), if provided. */
  injected?: string;
  /** Environment to read `KGPACKS_PACKS_DIR` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Working directory used for the default layout. Defaults to `process.cwd()`. */
  cwd?: string;
}

const nonEmpty = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** Resolves the packs directory following the documented precedence. */
export function resolvePacksDir(options: ResolvePacksDirOptions = {}): string {
  const { flag, injected, env = process.env, cwd = process.cwd() } = options;
  if (nonEmpty(flag)) return flag;
  if (nonEmpty(injected)) return injected;
  const fromEnv = env[PACKS_DIR_ENV];
  if (nonEmpty(fromEnv)) return fromEnv;
  return join(cwd, 'data', 'packs');
}
