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
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  PackInstallError,
  compareVersions,
  installPackFromStream,
  isValidSemver,
  loadManifestFromDir,
  packVersionFromReleaseTag,
} from '@kgpacks/packs';

import {
  DEFAULT_PACK_REPO,
  DEFAULT_PACK_TAG,
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
const HTTP_TIMEOUT_MS = 30_000;
const HTTP_MAX_RETRIES = 2;
const HTTP_RETRY_BASE_DELAY_MS = 250;
const HTTP_MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Resolves the base URL (directory) that hosts the index and part assets. */
export function resolvePackBaseUrl(
  opts: Pick<PullPackOptions, 'repo' | 'tag' | 'baseUrl'>,
): string {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/+$/, '');
  const repo = opts.repo ?? DEFAULT_PACK_REPO;
  const tag = opts.tag ?? DEFAULT_PACK_TAG;
  return `https://github.com/${repo}/releases/download/${tag}`;
}

class NoEligiblePackReleaseError extends PackInstallError {}

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
    let releases: unknown;
    try {
      releases = await retryHttp(async () => {
        const request = await fetchOnce(apiUrl, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wikigr-pack-pull' },
        });
        try {
          if (!request.response.ok) {
            await request.response.body?.cancel().catch(() => undefined);
            throw new PackInstallError(
              `cannot discover pack releases from ${repo} (HTTP ${request.response.status})`,
            );
          }
          try {
            return await request.response.json();
          } catch (error) {
            throw new TransientHttpError(
              `invalid release discovery response from ${repo}: ${errorMessage(error)}`,
            );
          }
        } finally {
          request.finish();
        }
      });
    } catch (error) {
      if (error instanceof PackInstallError) throw error;
      throw new PackInstallError(
        `cannot discover pack releases from ${repo}: ${errorMessage(error)}`,
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
        prerelease?: unknown;
        assets?: unknown;
      };
      const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
      const version = versionFromImmutableTag(name, tag);
      if (
        release.draft === true ||
        release.prerelease === true ||
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
  throw new NoEligiblePackReleaseError(
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
  try {
    return await retryHttp(async () => {
      const request = await fetchOnce(url);
      try {
        if (!request.response.ok) {
          await request.response.body?.cancel().catch(() => undefined);
          throw new PackInstallError(
            `pack index not found at ${url} (HTTP ${request.response.status})`,
          );
        }
        try {
          return Buffer.from(await request.response.arrayBuffer());
        } catch (error) {
          throw new TransientHttpError(`cannot read pack index at ${url}: ${errorMessage(error)}`);
        }
      } finally {
        request.finish();
      }
    });
  } catch (err) {
    if (err instanceof PackInstallError) throw err;
    throw new PackInstallError(`cannot reach pack index at ${url}: ${errorMessage(err)}`);
  }
}

/** Fetches an optional sibling asset (e.g. the `.sig`); returns null if absent. */
async function fetchOptionalText(url: string): Promise<string | null> {
  try {
    return await retryHttp(async () => {
      const request = await fetchOnce(url);
      try {
        if (request.response.status === 404) {
          await request.response.body?.cancel().catch(() => undefined);
          return null;
        }
        if (!request.response.ok) {
          await request.response.body?.cancel().catch(() => undefined);
          throw new PackInstallError(
            `cannot fetch optional release asset ${url} (HTTP ${request.response.status})`,
          );
        }
        try {
          return await request.response.text();
        } catch (error) {
          throw new TransientHttpError(
            `cannot read optional release asset ${url}: ${errorMessage(error)}`,
          );
        }
      } finally {
        request.finish();
      }
    });
  } catch (error) {
    if (error instanceof PackInstallError) throw error;
    throw new PackInstallError(
      `cannot reach optional release asset ${url}: ${errorMessage(error)}`,
    );
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
  const partFiles = new Set<string>();
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
    if (partFiles.has(part.file)) {
      throw new PackInstallError(`pack index at ${url} has duplicate part filename ${part.file}`);
    }
    partFiles.add(part.file);
  }
  return idx as PackReleaseIndex;
}

async function downloadPart(url: string, dest: string): Promise<void> {
  try {
    return await retryHttp(async () => {
      const request = await fetchOnce(url);
      try {
        const res = request.response;
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => undefined);
          throw new PackInstallError(`failed to download part ${url} (HTTP ${res.status})`);
        }
        const activity = new Transform({
          transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
            request.refreshTimeout();
            callback(null, chunk);
          },
        });
        try {
          await pipeline(
            Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
            activity,
            createWriteStream(dest),
          );
        } catch (error) {
          rmSync(dest, { force: true });
          throw new TransientHttpError(`download stream failed for ${url}: ${errorMessage(error)}`);
        }
      } finally {
        request.finish();
      }
    });
  } catch (err) {
    if (err instanceof PackInstallError) throw err;
    throw new PackInstallError(`cannot download part ${url}: ${errorMessage(err)}`);
  }
}

class TransientHttpError extends Error {
  constructor(
    message: string,
    readonly retryAfter?: string | null,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

interface TimedHttpResponse {
  response: Response;
  refreshTimeout(): void;
  finish(): void;
}

async function fetchOnce(url: string, init: RequestInit = {}): Promise<TimedHttpResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshTimeout = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  };
  const finish = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  refreshTimeout();
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'User-Agent': 'wikigr-pack-pull',
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
      signal: controller.signal,
    });
  } catch (error) {
    finish();
    throw new TransientHttpError(`request failed for ${url}: ${errorMessage(error)}`);
  }
  if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
    const retryAfter = response.headers.get('retry-after');
    await response.body?.cancel().catch(() => undefined);
    finish();
    throw new TransientHttpError(`HTTP ${response.status} from ${url}`, retryAfter);
  }
  return { response, refreshTimeout, finish };
}

async function retryHttp<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TransientHttpError) || attempt >= HTTP_MAX_RETRIES) throw error;
      const retryAfter = parseRetryAfter(error.retryAfter);
      const delay = Math.min(
        HTTP_MAX_RETRY_DELAY_MS,
        retryAfter ?? HTTP_RETRY_BASE_DELAY_MS * 2 ** attempt,
      );
      if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-reads finalized parts, verifying the exact bytes supplied to the installer. */
async function* verifiedPartBytes(
  paths: string[],
  index: PackReleaseIndex,
): AsyncGenerator<Buffer> {
  const overallHash = createHash('sha256');
  let finalArchiveChunk: Buffer | undefined;
  for (let partIndex = 0; partIndex < paths.length; partIndex++) {
    const path = paths[partIndex];
    const part = index.parts[partIndex];
    const partHash = createHash('sha256');
    let bytes = 0;
    let pendingChunk: Buffer | undefined;
    for await (const chunk of createReadStream(path)) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      partHash.update(buffer);
      overallHash.update(buffer);
      if (pendingChunk) yield pendingChunk;
      pendingChunk = buffer;
    }
    if (bytes !== part.bytes) {
      throw new PackInstallError(
        `part ${part.file} size mismatch: expected ${part.bytes} bytes, got ${bytes}`,
      );
    }
    if (partHash.digest('hex') !== part.sha256) {
      throw new PackInstallError(`part ${part.file} checksum mismatch`);
    }
    if (partIndex === paths.length - 1) finalArchiveChunk = pendingChunk;
    else if (pendingChunk) yield pendingChunk;
  }
  if (overallHash.digest('hex') !== index.sha256) {
    throw new PackInstallError(`assembled archive for ${index.name} failed overall checksum`);
  }
  if (finalArchiveChunk) yield finalArchiveChunk;
}

function waitForDrain(stream: PassThrough): Promise<boolean> {
  return new Promise((resolveDrain) => {
    const finish = (writable: boolean): void => {
      stream.off('drain', onDrain);
      stream.off('close', onClose);
      stream.off('error', onError);
      resolveDrain(writable);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    const onError = (): void => finish(false);
    stream.once('drain', onDrain);
    stream.once('close', onClose);
    stream.once('error', onError);
    if (stream.destroyed) finish(false);
  });
}

async function pumpVerifiedParts(
  paths: string[],
  index: PackReleaseIndex,
  destination: PassThrough,
): Promise<void> {
  let writable = true;
  try {
    for await (const chunk of verifiedPartBytes(paths, index)) {
      if (!writable) continue;
      try {
        writable = destination.write(chunk);
        if (!writable) writable = await waitForDrain(destination);
      } catch {
        writable = false;
      }
    }
    if (writable && !destination.destroyed) destination.end();
  } catch (error) {
    if (!destination.destroyed) destination.end();
    throw error;
  }
}

async function verifyInstalledPayloads(packDir: string): Promise<void> {
  const manifest = loadManifestFromDir(packDir);
  if (manifest.schemaVersion !== '2') return;
  const files = manifest.files;
  if (
    !Array.isArray(files) ||
    files.length !== 1 ||
    !files[0] ||
    typeof files[0] !== 'object' ||
    files[0].path !== 'pack.db'
  ) {
    throw new PackInstallError('schema-v2 manifest must declare exactly pack.db');
  }
  const payload = files[0];
  if (typeof payload.size !== 'number' || typeof payload.sha256 !== 'string') {
    throw new PackInstallError('schema-v2 manifest has invalid pack.db metadata');
  }
  const path = join(packDir, payload.path);
  let size: number;
  try {
    const status = statSync(path);
    if (!status.isFile()) throw new Error('not a regular file');
    size = status.size;
  } catch {
    throw new PackInstallError('payload pack.db is missing or is not a regular file');
  }
  if (size !== payload.size) {
    throw new PackInstallError(
      `payload pack.db size mismatch: expected ${payload.size} bytes, got ${size}`,
    );
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  if (hash.digest('hex') !== payload.sha256) {
    throw new PackInstallError('payload pack.db checksum mismatch');
  }
}

/**
 * Downloads, verifies, and installs a multi-part pack release. Throws
 * `PackInstallError` on any download or integrity failure (installing nothing).
 */
export async function pullPack(opts: PullPackOptions): Promise<PulledPack> {
  const automaticDiscovery = !opts.baseUrl && !opts.tag;
  const noVerify = opts.noVerify ?? false;
  let base: string;
  if (!automaticDiscovery) {
    base = resolvePackBaseUrl(opts);
  } else {
    try {
      base = await discoverLatestPackBaseUrl(opts.name, opts.repo ?? DEFAULT_PACK_REPO, !noVerify);
    } catch (error) {
      if (!(error instanceof NoEligiblePackReleaseError)) throw error;
      base = resolvePackBaseUrl({
        repo: opts.repo ?? DEFAULT_PACK_REPO,
        tag: DEFAULT_PACK_TAG,
      });
    }
  }
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
    for (const part of index.parts) {
      const dest = join(work, part.file);
      await downloadPart(`${base}/${part.file}`, dest);
      partPaths.push(dest);
    }

    const archive = new PassThrough();
    const [verification, installation] = await Promise.allSettled([
      pumpVerifiedParts(partPaths, index, archive),
      installPackFromStream(archive, opts.packsDir),
    ]);
    if (verification.status === 'rejected') {
      if (installation.status === 'fulfilled') {
        rmSync(installation.value.path, { recursive: true, force: true });
      }
      throw verification.reason;
    }
    if (installation.status === 'rejected') throw installation.reason;
    const installed = installation.value;
    try {
      await verifyInstalledPayloads(installed.path);
    } catch (error) {
      rmSync(installed.path, { recursive: true, force: true });
      if (error instanceof PackInstallError) throw error;
      throw new PackInstallError(
        `cannot verify installed payloads for ${opts.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
