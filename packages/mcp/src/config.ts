// Packs-directory resolution.
//
// Resolves the directory the server scans for installed packs. Shares the same
// default as the `wikigr` CLI — an XDG data dir (`$XDG_DATA_HOME/kgpacks`,
// falling back to `~/.local/share/kgpacks`) — with a `KGPACKS_PACKS_DIR`
// environment override, so an MCP host finds CLI-installed packs without extra
// configuration. See docs/packs-directory.md.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { PACKS_DIR_ENV } from './constants.js';

const nonEmpty = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * The XDG data directory the server defaults to: `$XDG_DATA_HOME/kgpacks`, else
 * (Windows) `%LOCALAPPDATA%\kgpacks`, else `~/.local/share/kgpacks`.
 */
function xdgDefaultPacksDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_DATA_HOME;
  if (nonEmpty(xdg)) return join(xdg, 'kgpacks');
  if (process.platform === 'win32' && nonEmpty(env.LOCALAPPDATA)) {
    return join(env.LOCALAPPDATA, 'kgpacks');
  }
  const home = nonEmpty(env.HOME) ? env.HOME : homedir();
  return join(home, '.local', 'share', 'kgpacks');
}

/**
 * Resolves the default packs directory.
 *
 * Returns the `KGPACKS_PACKS_DIR` override when set to a non-empty value,
 * otherwise the shared XDG default. `cwd` is retained for API/back-compat; the
 * default is now location-independent rather than a cwd-relative layout.
 */
export function resolveDefaultPacksDir(
  env: NodeJS.ProcessEnv = process.env,
  _cwd: string = process.cwd(),
): string {
  const override = env[PACKS_DIR_ENV];
  if (nonEmpty(override)) {
    return override;
  }
  return xdgDefaultPacksDir(env);
}
