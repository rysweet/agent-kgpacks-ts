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

import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  PackInstallError,
  compareVersions,
  installPackFromStream,
  isValidSemver,
  packVersionFromReleaseTag,
} from '@kgpacks/packs';

import {
  DEFAULT_PACK_REPO,
  PACK_RELEASE_INDEX_SUFFIX,
  PACK_RELEASE_SIGNATURE_SUFFIX,
} from './constants.js';
import { signaturePlan, verifyAgainstTrustedKeys } from './pack-signing.js';
import type { TrustedSigningKey } from './signing-key.js';

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
  /** Fixed part size (bytes) the archive was split at. */
  partSize?: number;
  /** Build provenance mirrored from the pack manifest (informational). */
  provenance?: Record<string, unknown>;
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
  /** Hard-fail unless a valid signature is present (`--require-signature`). */
  requireSignature?: boolean;
  /** Skip signature verification entirely (`--no-verify`); integrity still enforced. */
  noVerify?: boolean;
  /** Trusted signing keys (defaults to the committed set; injectable for tests). */
  trustedKeys?: readonly TrustedSigningKey[];
  /** Sink for human-readable signature status (defaults to stderr). */
  log?: (message: string) => void;
}

export interface PulledPack {
  name: string;
  version: string;
  path: string;
  parts: number;
  bytes: number;
  /** Trusted key id that signed the release, or `null` if unsigned/unverified. */
  signedBy: string | null;
}

const PART_FILE_RE = /^[A-Za-z0-9._-]+$/;
const DATED_RELEASE_VERSION_RE = /^\d{4}\.\d{2}(?:\.\d+)?$/;

/** Resolves the base URL (directory) that hosts the index and part assets. */
export function resolvePackBaseUrl(
  opts: Pick<PullPackOptions, 'repo' | 'tag' | 'baseUrl'>,
): string {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/+$/, '');
  const repo = opts.repo ?? DEFAULT_PACK_REPO;
  if (!opts.tag) {
    throw new PackInstallError('a release tag is required when resolving a static pack URL');
  }
  const tag = opts.tag;
  return `https://github.com/${repo}/releases/download/${tag}`;
}

export async function discoverLatestPackBaseUrl(
  name: string,
  repo: string,
  requireSignature = true,
): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new PackInstallError(`invalid pack repository: ${repo}`);
  }
  const expectedAsset = `${name}${PACK_RELEASE_INDEX_SUFFIX}`;
  const expectedSignature = `${expectedAsset}${PACK_RELEASE_SIGNATURE_SUFFIX}`;
  let latest: { tag: string; version: string } | undefined;
  for (let page = 1; ; page++) {
    const apiUrl = `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`;
    let response: Response;
    try {
      response = await fetch(apiUrl, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wikigr-pack-pull' },
      });
    } catch (error) {
      throw new PackInstallError(
        `cannot discover pack releases from ${repo}: ${(error as Error).message}`,
      );
    }
    if (!response.ok) {
      throw new PackInstallError(
        `cannot discover pack releases from ${repo} (HTTP ${response.status})`,
      );
    }
    let releases: unknown;
    try {
      releases = await response.json();
    } catch (error) {
      throw new PackInstallError(
        `invalid release discovery response from ${repo}: ${(error as Error).message}`,
      );
    }
    if (!Array.isArray(releases)) {
      throw new PackInstallError(`invalid release discovery response from ${repo}`);
    }
    for (const value of releases) {
      if (!value || typeof value !== 'object') continue;
      const release = value as {
        tag_name?: unknown;
        draft?: unknown;
        assets?: unknown;
      };
      const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
      const version = versionFromImmutableTag(name, tag);
      if (
        release.draft === true ||
        version === null ||
        hasPrerelease(version) ||
        !Array.isArray(release.assets)
      ) {
        continue;
      }
      let hasIndex = false;
      let hasSignature = !requireSignature;
      for (const asset of release.assets) {
        if (asset === null || typeof asset !== 'object') continue;
        const assetName = (asset as { name?: unknown }).name;
        if (assetName === expectedAsset) hasIndex = true;
        else if (assetName === expectedSignature) hasSignature = true;
        if (hasIndex && hasSignature) break;
      }
      if (hasIndex && hasSignature) {
        const candidate = { tag, version };
        if (!latest) {
          latest = candidate;
        } else {
          const precedence = compareVersions(candidate.version, latest.version);
          const versionOrder = compareBytewise(candidate.version, latest.version);
          if (
            precedence > 0 ||
            (precedence === 0 &&
              (versionOrder > 0 ||
                (versionOrder === 0 && compareBytewise(candidate.tag, latest.tag) > 0)))
          ) {
            latest = candidate;
          }
        }
      }
    }
    if (releases.length < 100) break;
  }
  if (latest) return `https://github.com/${repo}/releases/download/${latest.tag}`;
  throw new PackInstallError(
    `no immutable release containing ${expectedAsset}${
      requireSignature ? ` and ${expectedSignature}` : ''
    } was found in ${repo}`,
  );
}

function compareBytewise(left: string, right: string): -1 | 0 | 1 {
  // Valid SemVer and immutable release-tag suffixes are ASCII. Tags compared
  // here also share the exact pack-name prefix, so UTF-16 and UTF-8 ordering
  // are identical without allocating two temporary Buffers per comparison.
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasPrerelease(version: string): boolean {
  // versionFromImmutableTag has already performed strict SemVer validation.
  // A '-' before build metadata therefore unambiguously starts a prerelease.
  const prerelease = version.indexOf('-');
  const build = version.indexOf('+');
  return prerelease !== -1 && (build === -1 || prerelease < build);
}

function versionFromImmutableTag(name: string, tag: string): string | null {
  const versionPrefix = `${name}-v`;
  if (tag.startsWith(versionPrefix)) {
    const version = tag.slice(versionPrefix.length);
    return isValidSemver(version) ? version : null;
  }
  const datedPrefix = `${name}-`;
  if (!tag.startsWith(datedPrefix)) return null;
  if (!DATED_RELEASE_VERSION_RE.test(tag.slice(datedPrefix.length))) return null;
  try {
    return packVersionFromReleaseTag(tag);
  } catch {
    return null;
  }
}

async function fetchIndexBytes(url: string): Promise<Buffer> {
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
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new PackInstallError(`cannot read pack index at ${url}: ${(err as Error).message}`);
  }
}

/** Fetches an optional sibling asset (e.g. the `.sig`); returns null if absent. */
async function fetchOptionalText(url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

/** Decodes a base64 detached-signature file to raw bytes, or null if malformed. */
function decodeSignature(text: string): Buffer | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return Buffer.from(trimmed, 'base64');
  } catch {
    return null;
  }
}

function parseIndexJson(bytes: Buffer, url: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
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

async function downloadPart(
  url: string,
  dest: string,
  overallHash: Hash,
): Promise<{ hash: string; bytes: number }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new PackInstallError(`cannot download part ${url}: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    throw new PackInstallError(`failed to download part ${url} (HTTP ${res.status})`);
  }
  const partHash = createHash('sha256');
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      bytes += chunk.length;
      partHash.update(chunk);
      overallHash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    verifier,
    createWriteStream(dest),
  );
  return { hash: partHash.digest('hex'), bytes };
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
  const automaticDiscovery = !opts.baseUrl && !opts.tag;
  const noVerify = opts.noVerify ?? false;
  const base = !automaticDiscovery
    ? resolvePackBaseUrl(opts)
    : await discoverLatestPackBaseUrl(opts.name, opts.repo ?? DEFAULT_PACK_REPO, !noVerify);
  const indexUrl = `${base}/${opts.name}${PACK_RELEASE_INDEX_SUFFIX}`;
  const log = opts.log ?? ((message: string) => process.stderr.write(`${message}\n`));

  // Fetch the RAW index bytes and verify authenticity BEFORE parsing the JSON, so
  // a tampered index cannot influence the client before its signature is checked.
  const indexBytes = await fetchIndexBytes(indexUrl);
  const sigText = await fetchOptionalText(`${indexUrl}${PACK_RELEASE_SIGNATURE_SUFFIX}`);
  const present = sigText !== null && sigText.trim() !== '';
  const signature = present ? decodeSignature(sigText as string) : null;
  const signedBy = signature
    ? verifyAgainstTrustedKeys(indexBytes, signature, opts.trustedKeys)
    : null;
  const action = signaturePlan({
    present,
    valid: signedBy !== null,
    requireSignature: automaticDiscovery && !noVerify ? true : (opts.requireSignature ?? false),
    noVerify,
  });
  if (action === 'fail') {
    throw new PackInstallError(
      present
        ? `signature verification failed for ${opts.name} (untrusted key or tampered index)`
        : `${opts.name} release is unsigned and --require-signature was set`,
    );
  }
  if (action === 'verify') {
    log(`✓ signature verified (Ed25519, key ${signedBy})`);
  } else if (action === 'warn') {
    log(
      `warning: ${opts.name} release is unsigned — installing on SHA-256 integrity only ` +
        `(pass --require-signature to enforce authenticity)`,
    );
  }

  const index = assertIndex(parseIndexJson(indexBytes, indexUrl), opts.name, indexUrl);

  const work = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), 'kgpacks-pull-'));
  try {
    const partPaths: string[] = [];
    const overall = createHash('sha256');
    for (const part of index.parts) {
      const dest = join(work, part.file);
      const { hash, bytes } = await downloadPart(`${base}/${part.file}`, dest, overall);
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
    // touching the install root. The digest was accumulated in part order while
    // streaming each download to disk, avoiding another full archive read.
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
      signedBy,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
