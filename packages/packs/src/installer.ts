// Pack installer with security parity (ports the upstream installer module).
//
// Extracts a local `.tar.gz` into an install root. Every entry is validated
// BEFORE any byte is written; extraction goes into a staging directory inside
// the install root and is committed with a single atomic `rename`, so a failed
// install never leaves a partial pack and nothing is ever written outside the
// target. Traversal, absolute-path, and symlink/hardlink/device entries are
// rejected outright.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { PackInstallError } from './errors.js';
import { MANIFEST_FILENAME, loadManifest } from './manifest.js';
import type { PackManifest } from './manifest.js';
import { parseTar } from './tar.js';
import type { TarEntry } from './tar.js';

// Defensive caps against decompression bombs / oversized archives.
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GiB uncompressed
const MAX_ENTRIES = 100_000;

export interface InstalledPack {
  name: string;
  version: string;
  path: string;
  manifest: PackManifest;
}

function assertSafeEntry(entry: TarEntry): void {
  const { name, type } = entry;
  if (type !== 'file' && type !== 'dir') {
    throw new PackInstallError(
      `rejected unsafe entry ${JSON.stringify(name)}: ${type} entries are not allowed`,
    );
  }
  if (name.length === 0) {
    throw new PackInstallError('rejected unsafe entry: empty entry name');
  }
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) {
    throw new PackInstallError(
      `rejected unsafe entry ${JSON.stringify(name)}: absolute paths are not allowed`,
    );
  }
  if (name.split(/[/\\]/).includes('..')) {
    throw new PackInstallError(
      `rejected unsafe entry ${JSON.stringify(name)}: path traversal is not allowed`,
    );
  }
}

function writeEntries(entries: TarEntry[], staging: string): void {
  const stagingRoot = resolve(staging);
  for (const entry of entries) {
    const target = resolve(staging, entry.name);
    // Belt-and-suspenders containment check in addition to assertSafeEntry.
    if (target !== stagingRoot && !target.startsWith(stagingRoot + sep)) {
      throw new PackInstallError(
        `rejected unsafe entry ${JSON.stringify(entry.name)}: escapes the install target`,
      );
    }
    if (entry.type === 'dir') {
      mkdirSync(target, { recursive: true, mode: 0o755 });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.content, { mode: 0o644 });
    }
  }
}

export function installPack(archivePath: string, installRoot: string): InstalledPack {
  let gz: Buffer;
  try {
    gz = readFileSync(archivePath);
  } catch (err) {
    throw new PackInstallError(`cannot read archive at ${archivePath}: ${(err as Error).message}`);
  }

  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: MAX_TOTAL_BYTES });
  } catch (err) {
    throw new PackInstallError(
      `archive at ${archivePath} is not a valid gzip stream: ${(err as Error).message}`,
    );
  }

  let entries: TarEntry[];
  try {
    entries = parseTar(tar);
  } catch (err) {
    throw new PackInstallError(
      `archive at ${archivePath} is not a valid tar stream: ${(err as Error).message}`,
    );
  }

  if (entries.length > MAX_ENTRIES) {
    throw new PackInstallError(`archive has too many entries (> ${MAX_ENTRIES})`);
  }

  // Validate EVERY entry before creating or writing anything.
  for (const entry of entries) assertSafeEntry(entry);

  mkdirSync(installRoot, { recursive: true });
  const staging = join(installRoot, `.staging-${randomBytes(8).toString('hex')}`);
  try {
    mkdirSync(staging, { recursive: true });
    writeEntries(entries, staging);

    const manifest = loadManifest(join(staging, MANIFEST_FILENAME));
    const dest = join(installRoot, manifest.name);
    if (existsSync(dest)) {
      throw new PackInstallError(`pack already installed: ${JSON.stringify(manifest.name)}`);
    }
    renameSync(staging, dest);
    return { name: manifest.name, version: manifest.version, path: dest, manifest };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}
