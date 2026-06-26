// `pack pull` core: download a multi-part, integrity-checked pack release and
// install it.
//
// Large knowledge packs (the full CVE pack is ~6-7 GiB) exceed GitHub's 2 GiB
// per-asset limit, so a published pack is a set of `<name>.tar.gz.NNN` parts plus
// a `<name>.pack-release.json` index (per-part + overall SHA-256). This module
// fetches the index, downloads every part to a temp dir (streamed to disk, never
// buffered whole), verifies each part's SHA-256 AND the overall archive SHA-256,
// then installs by streaming the concatenated parts through
// `installPackFromStream` — which validates every tar entry before writing a byte
// and commits with a single atomic rename. Any integrity or download failure
// raises `PackInstallError` (CLI exit code 5) and installs nothing.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PackInstallError, installPackFromStream } from '@kgpacks/packs';

import { DEFAULT_PACK_REPO, DEFAULT_PACK_TAG, PACK_RELEASE_INDEX_SUFFIX } from './constants.js';

/** One part of a multi-part pack release. */
export interface PackReleasePart {
  file: string;
  bytes: number;
  sha256: string;
}

/** The `<name>.pack-release.json` index published alongside the part assets. */
export interface PackReleaseIndex {
  name: string;
  version: string;
  format: string;
  sha256: string;
  totalBytes: number;
  parts: PackReleasePart[];
  model?: string;
  createdAt?: string;
}

export interface PullPackOptions {
  /** Pack name; matches `<name>.pack-release.json` in the release. */
  name: string;
  /** Packs directory to install into. */
  packsDir: string;
  /** Source repository `owner/repo` (ignored when `baseUrl` is set). */
  repo?: string;
  /** Release tag (ignored when `baseUrl` is set). */
  tag?: string;
  /** Explicit base URL containing the index + parts (overrides repo/tag). */
  baseUrl?: string;
  /** Root for the scratch download directory (defaults to the OS temp dir). */
  tmpRoot?: string;
}

export interface PulledPack {
  name: string;
  version: string;
  path: string;
  parts: number;
  bytes: number;
}

const PART_FILE_RE = /^[A-Za-z0-9._-]+$/;

/** Resolves the base URL (directory) that hosts the index and part assets. */
export function resolvePackBaseUrl(
  opts: Pick<PullPackOptions, 'repo' | 'tag' | 'baseUrl'>,
): string {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/+$/, '');
  const repo = opts.repo ?? DEFAULT_PACK_REPO;
  const tag = opts.tag ?? DEFAULT_PACK_TAG;
  return `https://github.com/${repo}/releases/download/${tag}`;
}

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new PackInstallError(`cannot reach pack index at ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new PackInstallError(`pack index not found at ${url} (HTTP ${res.status})`);
  }
  try {
    return (await res.json()) as unknown;
  } catch (err) {
    throw new PackInstallError(`pack index at ${url} is not valid JSON: ${(err as Error).message}`);
  }
}

function assertIndex(value: unknown, expectedName: string, url: string): PackReleaseIndex {
  const idx = value as Partial<PackReleaseIndex> | null;
  if (!idx || typeof idx !== 'object') {
    throw new PackInstallError(`pack index at ${url} is malformed`);
  }
  if (idx.name !== expectedName) {
    throw new PackInstallError(
      `pack index name mismatch: requested ${JSON.stringify(expectedName)}, index declares ${JSON.stringify(idx.name)}`,
    );
  }
  if (typeof idx.sha256 !== 'string' || !Array.isArray(idx.parts) || idx.parts.length === 0) {
    throw new PackInstallError(`pack index at ${url} has no parts or overall checksum`);
  }
  for (const part of idx.parts) {
    if (
      !part ||
      typeof part.file !== 'string' ||
      typeof part.sha256 !== 'string' ||
      typeof part.bytes !== 'number' ||
      !PART_FILE_RE.test(part.file)
    ) {
      throw new PackInstallError(`pack index at ${url} has an invalid part entry`);
    }
  }
  return idx as PackReleaseIndex;
}

async function sha256File(path: string): Promise<{ hash: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += (chunk as Buffer).length;
    hash.update(chunk);
  }
  return { hash: hash.digest('hex'), bytes };
}

async function downloadPart(url: string, dest: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new PackInstallError(`cannot download part ${url}: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    throw new PackInstallError(`failed to download part ${url} (HTTP ${res.status})`);
  }
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(dest),
  );
}

/** Async generator concatenating part files in order into one byte stream. */
async function* concatParts(paths: string[]): AsyncGenerator<Buffer> {
  for (const path of paths) {
    for await (const chunk of createReadStream(path)) {
      yield chunk as Buffer;
    }
  }
}

/**
 * Downloads, verifies, and installs a multi-part pack release. Throws
 * `PackInstallError` on any download or integrity failure (installing nothing).
 */
export async function pullPack(opts: PullPackOptions): Promise<PulledPack> {
  const base = resolvePackBaseUrl(opts);
  const indexUrl = `${base}/${opts.name}${PACK_RELEASE_INDEX_SUFFIX}`;
  const index = assertIndex(await fetchJson(indexUrl), opts.name, indexUrl);

  const work = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), 'kgpacks-pull-'));
  try {
    const partPaths: string[] = [];
    for (const part of index.parts) {
      const dest = join(work, part.file);
      await downloadPart(`${base}/${part.file}`, dest);
      const { hash, bytes } = await sha256File(dest);
      if (bytes !== part.bytes) {
        throw new PackInstallError(
          `part ${part.file} size mismatch: expected ${part.bytes} bytes, got ${bytes}`,
        );
      }
      if (hash !== part.sha256) {
        throw new PackInstallError(`part ${part.file} checksum mismatch`);
      }
      partPaths.push(dest);
    }

    // Verify the overall archive checksum over the concatenated parts before
    // touching the install root.
    const overall = createHash('sha256');
    for await (const chunk of concatParts(partPaths)) overall.update(chunk);
    if (overall.digest('hex') !== index.sha256) {
      throw new PackInstallError(`assembled archive for ${opts.name} failed overall checksum`);
    }

    const installed = await installPackFromStream(
      Readable.from(concatParts(partPaths)),
      opts.packsDir,
    );
    return {
      name: installed.name,
      version: installed.version,
      path: installed.path,
      parts: index.parts.length,
      bytes: index.totalBytes,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
