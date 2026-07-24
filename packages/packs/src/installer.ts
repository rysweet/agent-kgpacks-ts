// Pack installer with security parity (ports the upstream installer module).
//
// Extracts a local `.tar.gz` into an install root. Every entry is validated
// BEFORE any byte is written; extraction goes into a staging directory inside
// the install root and is committed with a single atomic `rename`, so a failed
// install never leaves a partial pack and nothing is ever written outside the
// target. Traversal, absolute-path, and symlink/hardlink/device entries are
// rejected outright.

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { createGunzip, gunzipSync } from 'node:zlib';

import { PackInstallError } from './errors.js';
import { MANIFEST_FILENAME, loadManifest } from './manifest.js';
import type { PackManifest } from './manifest.js';
import { TAR_BLOCK, isZeroBlock, parseTar, parseTarHeader } from './tar.js';
import type { TarEntry } from './tar.js';

// Defensive caps against decompression bombs / oversized archives.
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GiB uncompressed (buffer path)
const MAX_ENTRIES = 100_000;
// Generous ceiling for the streaming path, which never buffers the whole
// archive. Sized for multi-GB knowledge packs (the full CVE pack is ~6-7 GiB)
// while still rejecting a runaway/bomb archive.
const STREAM_MAX_TOTAL_BYTES = 32 * 1024 * 1024 * 1024; // 32 GiB

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

const EMPTY_CONTENT: Buffer = Buffer.alloc(0);

/**
 * Streams a gzipped tar from `source` into `staging`, validating every entry's
 * header BEFORE any of its bytes are written. Bounded memory: only one decoded
 * chunk plus a partial block is ever held, so multi-GB packs install without
 * buffering the whole archive. Security parity with the buffer path: traversal,
 * absolute-path, and symlink/hardlink/device entries are rejected, and a
 * containment check guarantees nothing is written outside `staging`.
 */
async function extractTarGzToDir(
  source: Readable,
  staging: string,
  maxTotalBytes: number,
): Promise<void> {
  const stagingRoot = resolve(staging);
  const gz = source.pipe(createGunzip());

  let pending: Buffer = EMPTY_CONTENT;
  let entries = 0;
  let totalBytes = 0;
  let prevZero = false;
  let fd = -1;
  let remaining = 0; // content bytes left for the current file
  let pad = 0; // zero-padding bytes left to skip after the current file
  let mode: 'header' | 'content' | 'pad' | 'done' = 'header';

  try {
    for await (const chunk of gz as AsyncIterable<Buffer>) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

      let progressed = true;
      while (progressed && mode !== 'done') {
        progressed = false;

        if (mode === 'header') {
          if (pending.length < TAR_BLOCK) break;
          const block = pending.subarray(0, TAR_BLOCK);
          pending = pending.subarray(TAR_BLOCK);
          progressed = true;

          if (isZeroBlock(block, 0)) {
            if (prevZero) mode = 'done';
            else prevZero = true;
            continue;
          }
          prevZero = false;

          const header = parseTarHeader(block);
          assertSafeEntry({ name: header.name, type: header.type, content: EMPTY_CONTENT });
          if (++entries > MAX_ENTRIES) {
            throw new PackInstallError(`archive has too many entries (> ${MAX_ENTRIES})`);
          }
          const target = resolve(staging, header.name);
          if (target !== stagingRoot && !target.startsWith(stagingRoot + sep)) {
            throw new PackInstallError(
              `rejected unsafe entry ${JSON.stringify(header.name)}: escapes the install target`,
            );
          }

          if (header.type === 'dir') {
            mkdirSync(target, { recursive: true, mode: 0o755 });
            continue;
          }

          totalBytes += header.size;
          if (totalBytes > maxTotalBytes) {
            throw new PackInstallError(
              `archive exceeds the ${maxTotalBytes}-byte uncompressed limit`,
            );
          }
          mkdirSync(dirname(target), { recursive: true });
          fd = openSync(target, 'w', 0o644);
          remaining = header.size;
          pad = (TAR_BLOCK - (header.size % TAR_BLOCK)) % TAR_BLOCK;
          if (remaining === 0) {
            closeSync(fd);
            fd = -1;
            mode = pad > 0 ? 'pad' : 'header';
          } else {
            mode = 'content';
          }
          continue;
        }

        if (mode === 'content') {
          if (pending.length === 0) break;
          const n = Math.min(remaining, pending.length);
          writeSync(fd, pending, 0, n);
          pending = pending.subarray(n);
          remaining -= n;
          progressed = n > 0;
          if (remaining === 0) {
            closeSync(fd);
            fd = -1;
            mode = pad > 0 ? 'pad' : 'header';
          }
          continue;
        }

        // mode === 'pad'
        if (pending.length === 0) break;
        const skip = Math.min(pad, pending.length);
        pending = pending.subarray(skip);
        pad -= skip;
        progressed = skip > 0;
        if (pad === 0) mode = 'header';
      }

      if (mode === 'done') break;
    }
  } catch (err) {
    if (err instanceof PackInstallError) throw err;
    throw new PackInstallError(
      `archive stream is not a valid gzip/tar stream: ${(err as Error).message}`,
    );
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // best-effort: the install is already failing/cleaning up
      }
    }
  }

  if (mode === 'content' || mode === 'pad') {
    throw new PackInstallError('archive ended in the middle of an entry (truncated)');
  }
}

/**
 * Installs a pack from a streamed gzipped-tar `source` (e.g. a file read stream
 * or a concatenation of downloaded multi-part assets). Unlike {@link installPack},
 * this never buffers the whole archive, so it scales to multi-GB packs. The same
 * security model applies, and the pack is committed with a single atomic rename
 * once the manifest is read, so a failed install never leaves a partial pack.
 */
export async function installPackFromStream(
  source: Readable,
  installRoot: string,
  options: {
    maxTotalBytes?: number;
    validate?: (staging: string, manifest: PackManifest) => void | Promise<void>;
  } = {},
): Promise<InstalledPack> {
  const maxTotalBytes = options.maxTotalBytes ?? STREAM_MAX_TOTAL_BYTES;
  mkdirSync(installRoot, { recursive: true });
  const staging = join(installRoot, `.staging-${randomBytes(8).toString('hex')}`);
  mkdirSync(staging, { recursive: true });
  try {
    await extractTarGzToDir(source, staging, maxTotalBytes);
    const manifest = loadManifest(join(staging, MANIFEST_FILENAME));
    await options.validate?.(staging, manifest);
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
