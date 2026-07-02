// Packs-directory resolution.
//
// Resolves the install root the CLI reads/writes packs under. Precedence mirrors
// the frozen design: the explicit `--packs-dir` flag wins, then a programmatic
// injection (used by tests and embedders), then the `KGPACKS_PACKS_DIR`
// environment override, and finally an XDG data directory
// (`$XDG_DATA_HOME/kgpacks`, falling back to `~/.local/share/kgpacks`). The
// installed CLI therefore finds its packs from any working directory, and shares
// the same default as `@kgpacks/mcp`. See docs/packs-directory.md.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { PACKS_DIR_ENV } from './constants.js';

/** Inputs to {@link resolvePacksDir}, in descending precedence. */
export interface ResolvePacksDirOptions {
  /** Value of the global `--packs-dir` flag, if provided. */
  flag?: string;
  /** Programmatic override (test/embedder injection), if provided. */
  injected?: string;
  /** Environment to read `KGPACKS_PACKS_DIR` / XDG vars from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Working directory. Retained for API/back-compat; the default now follows the
   * XDG data dir (location-independent) rather than a cwd-relative layout.
   */
  cwd?: string;
}

const nonEmpty = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * The XDG data directory the installed CLI/server default to:
 * `$XDG_DATA_HOME/kgpacks`, else (Windows) `%LOCALAPPDATA%\kgpacks`, else
 * `~/.local/share/kgpacks`.
 */
export function xdgDefaultPacksDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  if (nonEmpty(xdg)) return join(xdg, 'kgpacks');
  if (process.platform === 'win32' && nonEmpty(env.LOCALAPPDATA)) {
    return join(env.LOCALAPPDATA, 'kgpacks');
  }
  const home = nonEmpty(env.HOME) ? env.HOME : homedir();
  return join(home, '.local', 'share', 'kgpacks');
}

/** Resolves the packs directory following the documented precedence. */
export function resolvePacksDir(options: ResolvePacksDirOptions = {}): string {
  const { flag, injected, env = process.env } = options;
  if (nonEmpty(flag)) return flag;
  if (nonEmpty(injected)) return injected;
  const fromEnv = env[PACKS_DIR_ENV];
  if (nonEmpty(fromEnv)) return fromEnv;
  return xdgDefaultPacksDir(env);
}
