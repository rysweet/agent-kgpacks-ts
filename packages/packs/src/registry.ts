// Registry operations over an install root (ports the upstream registry module).
//
// list / info / remove for installed packs. The path-safety control lives here:
// `name` is re-validated against PACK_NAME_RE BEFORE any path is built or
// removed, so a malicious name can never traverse out of the install root.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ManifestValidationError, PackNotFoundError } from './errors.js';
import type { InstalledPack } from './installer.js';
import { MANIFEST_FILENAME, PACK_NAME_RE, loadManifestFromDir } from './manifest.js';

function assertValidName(name: string): void {
  if (typeof name !== 'string' || !PACK_NAME_RE.test(name)) {
    throw new ManifestValidationError(
      `invalid pack name ${JSON.stringify(name)} (must match PACK_NAME_RE)`,
    );
  }
}

export function listPacks(installRoot: string): InstalledPack[] {
  let dirents;
  try {
    dirents = readdirSync(installRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const packs: InstalledPack[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const path = join(installRoot, dirent.name);
    let manifest;
    try {
      manifest = loadManifestFromDir(path);
    } catch {
      continue; // directories without a valid manifest are skipped
    }
    packs.push({ name: manifest.name, version: manifest.version, path, manifest });
  }
  return packs;
}

export function packInfo(installRoot: string, name: string): InstalledPack {
  assertValidName(name);
  const path = join(installRoot, name);
  if (!existsSync(join(path, MANIFEST_FILENAME))) {
    throw new PackNotFoundError(`pack not found: ${name}`);
  }
  const manifest = loadManifestFromDir(path);
  return { name: manifest.name, version: manifest.version, path, manifest };
}

export function removePack(installRoot: string, name: string): void {
  assertValidName(name);
  const path = join(installRoot, name);
  if (!existsSync(path)) {
    throw new PackNotFoundError(`pack not found: ${name}`);
  }
  rmSync(path, { recursive: true, force: true });
}
