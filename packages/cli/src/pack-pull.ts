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
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

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
import {
  DEFAULT_EXTERNAL_LIMITS,
  ExternalServiceError,
  GITHUB_ASSET_ORIGINS,
  createExternalContext,
  downloadBoundedFile,
  exactOriginPolicy,
  fetchBoundedBytes,
  type ExternalContext,
  type ExternalServiceLimits,
  type ExternalTransportOptions,
  type TransportPolicy,
} from './external-transport.js';
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
  /** Cancels discovery, retry waits, downloads, verification, and installation. */
  signal?: AbortSignal;
  /** Injectable bounded transport settings for tests and constrained environments. */
  externalLimits?: Partial<ExternalServiceLimits>;
  /** Injectable fetch implementation for tests. */
  fetch?: ExternalTransportOptions['fetch'];
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
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GITHUB_API_POLICY: TransportPolicy = {
  allowedOrigins: new Set(['https://api.github.com']),
};

interface GithubAsset {
  name: string;
  url: string;
  size?: number;
}

interface ReleaseCandidate {
  tag: string;
  version: string;
  publishedAt: number;
  releaseId: string;
  baseUrl: string;
  assets: ReadonlyMap<string, readonly GithubAsset[]>;
}

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
  options: ExternalTransportOptions = {},
): Promise<string> {
  const timeout = options.limits?.discoveryTimeoutMs ?? DEFAULT_EXTERNAL_LIMITS.discoveryTimeoutMs;
  const context = createExternalContext(options, timeout);
  return (await discoverLatestPackRelease(name, repo, requireSignature, context)).baseUrl;
}

async function discoverLatestPackRelease(
  name: string,
  repo: string,
  requireSignature: boolean,
  context: ExternalContext,
): Promise<ReleaseCandidate> {
  if (!GITHUB_REPO_RE.test(repo)) {
    throw new ExternalServiceError('trust', 'pack repository is not an approved owner/repository');
  }
  const expectedAsset = `${name}${PACK_RELEASE_INDEX_SUFFIX}`;
  const expectedSignature = `${expectedAsset}${PACK_RELEASE_SIGNATURE_SUFFIX}`;
  let latest: ReleaseCandidate | undefined;
  for (let page = 1; page <= context.limits.discoveryMaxPages; page++) {
    const apiUrl = `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`;
    const bytes = await fetchBoundedBytes(
      context,
      apiUrl,
      GITHUB_API_POLICY,
      context.limits.discoveryPageBytes,
      'GitHub release discovery',
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wikigr-pack-pull' },
      },
    );
    let releases: unknown;
    try {
      releases = JSON.parse((bytes as Buffer).toString('utf8')) as unknown;
    } catch {
      throw new ExternalServiceError(
        'invalid-response',
        'GitHub release discovery returned invalid JSON',
      );
    }
    if (!Array.isArray(releases)) {
      throw new ExternalServiceError(
        'invalid-response',
        'GitHub release discovery returned an invalid release list',
      );
    }
    for (const value of releases) {
      if (!value || typeof value !== 'object') continue;
      const release = value as {
        id?: unknown;
        tag_name?: unknown;
        draft?: unknown;
        prerelease?: unknown;
        published_at?: unknown;
        assets?: unknown;
      };
      const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
      const version = versionFromImmutableTag(name, tag);
      if (
        release.draft !== false ||
        release.prerelease !== false ||
        !isAscii(tag) ||
        version === null ||
        hasPrerelease(version) ||
        !Array.isArray(release.assets)
      ) {
        continue;
      }
      const publishedAt =
        typeof release.published_at === 'string' ? Date.parse(release.published_at) : Number.NaN;
      const releaseId = normalizeReleaseId(release.id);
      if (!Number.isFinite(publishedAt) || releaseId === null) continue;

      const assets = new Map<string, GithubAsset[]>();
      for (const asset of release.assets) {
        if (asset === null || typeof asset !== 'object') continue;
        const parsed = parseGithubAsset(asset, repo, tag);
        if (!parsed) continue;
        const matches = assets.get(parsed.name) ?? [];
        matches.push(parsed);
        assets.set(parsed.name, matches);
      }
      const indexes = assets.get(expectedAsset) ?? [];
      const signatures = assets.get(expectedSignature) ?? [];
      if (indexes.length > 1 || signatures.length > 1) {
        throw new ExternalServiceError(
          'ambiguous',
          'GitHub release contains ambiguous pack corpus assets',
        );
      }
      if (indexes.length !== 1 || (requireSignature && signatures.length !== 1)) continue;

      const candidate: ReleaseCandidate = {
        tag,
        version,
        publishedAt,
        releaseId,
        baseUrl: `https://github.com/${repo}/releases/download/${tag}`,
        assets,
      };
      if (!latest) {
        latest = candidate;
      } else {
        const order = compareCandidates(candidate, latest);
        if (order === 0) {
          throw new ExternalServiceError(
            'ambiguous',
            'GitHub release discovery returned indistinguishable candidates',
          );
        }
        if (order > 0) latest = candidate;
      }
    }
    if (releases.length < 100) break;
    if (page === context.limits.discoveryMaxPages) {
      throw new ExternalServiceError(
        'response-too-large',
        'GitHub release discovery exceeded its pagination limit',
      );
    }
  }
  if (latest) return latest;
  throw new ExternalServiceError(
    'not-found',
    `no stable immutable release containing ${expectedAsset}${
      requireSignature ? ` and ${expectedSignature}` : ''
    } was found in ${repo}`,
  );
}

function parseGithubAsset(value: object, repo: string, tag: string): GithubAsset | null {
  const raw = value as {
    name?: unknown;
    browser_download_url?: unknown;
    size?: unknown;
  };
  if (typeof raw.name !== 'string' || typeof raw.browser_download_url !== 'string') return null;
  assertGithubAssetBinding(raw.browser_download_url, repo, tag, raw.name);
  const size =
    typeof raw.size === 'number' && Number.isSafeInteger(raw.size) && raw.size >= 0
      ? raw.size
      : undefined;
  return { name: raw.name, url: raw.browser_download_url, size };
}

function assertGithubAssetBinding(
  urlValue: string,
  repo: string,
  tag: string,
  asset: string,
): void {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new ExternalServiceError('trust', 'GitHub release asset URL is invalid');
  }
  if (
    url.origin !== 'https://github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ExternalServiceError(
      'trust',
      'GitHub release asset is not bound to an approved origin',
    );
  }
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new ExternalServiceError('trust', 'GitHub release asset path is invalid');
  }
  const [owner, repository] = repo.split('/');
  const expected = [owner, repository, 'releases', 'download', tag, asset];
  if (
    segments.length !== expected.length ||
    segments.some((segment, index) => segment !== expected[index])
  ) {
    throw new ExternalServiceError(
      'trust',
      'GitHub release asset does not match the requested repository and tag',
    );
  }
}

function normalizeReleaseId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  return null;
}

function compareCandidates(left: ReleaseCandidate, right: ReleaseCandidate): -1 | 0 | 1 {
  const version = compareVersions(left.version, right.version);
  if (version !== 0) return version;
  if (left.publishedAt !== right.publishedAt) {
    return left.publishedAt < right.publishedAt ? -1 : 1;
  }
  const tag = compareAscii(left.tag, right.tag);
  if (tag !== 0) return tag;
  return compareDecimalIds(left.releaseId, right.releaseId);
}

function compareDecimalIds(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return compareAscii(left, right);
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function compareAscii(left: string, right: string): -1 | 0 | 1 {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
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

/** Decodes a base64 detached-signature file to raw bytes, or null if malformed. */
function decodeSignature(text: string): Buffer | null {
  const trimmed = text.trim();
  if (
    !trimmed ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(trimmed)
  ) {
    return null;
  }
  const decoded = Buffer.from(trimmed, 'base64');
  return decoded.toString('base64') === trimmed ? decoded : null;
}

function parseIndexJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new ExternalServiceError('invalid-response', 'pack release index is not valid JSON');
  }
}

function assertIndex(
  value: unknown,
  expectedName: string,
  limits: ExternalServiceLimits,
): PackReleaseIndex {
  const idx = value as Partial<PackReleaseIndex> | null;
  if (!idx || typeof idx !== 'object') {
    throw new ExternalServiceError('invalid-response', 'pack release index is malformed');
  }
  if (idx.name !== expectedName) {
    throw new ExternalServiceError(
      'trust',
      `pack index name mismatch: requested ${JSON.stringify(expectedName)}, index declares ${JSON.stringify(idx.name)}`,
    );
  }
  if (
    idx.format !== 'tar.gz-multipart-v1' ||
    typeof idx.version !== 'string' ||
    !isValidSemver(idx.version) ||
    typeof idx.sha256 !== 'string' ||
    !SHA256_RE.test(idx.sha256) ||
    !Number.isSafeInteger(idx.totalBytes) ||
    (idx.totalBytes as number) <= 0 ||
    (idx.totalBytes as number) > limits.corpusBytes ||
    !Array.isArray(idx.parts) ||
    idx.parts.length === 0 ||
    idx.parts.length > limits.maxParts
  ) {
    throw new ExternalServiceError('invalid-response', 'pack release index metadata is invalid');
  }
  const files = new Set<string>();
  let totalBytes = 0;
  for (let position = 0; position < idx.parts.length; position++) {
    const part = idx.parts[position];
    const expectedFile = `${expectedName}.tar.gz.${String(position).padStart(3, '0')}`;
    if (
      !part ||
      typeof part.file !== 'string' ||
      part.file !== expectedFile ||
      files.has(part.file) ||
      typeof part.sha256 !== 'string' ||
      !SHA256_RE.test(part.sha256) ||
      typeof part.bytes !== 'number' ||
      !Number.isSafeInteger(part.bytes) ||
      part.bytes <= 0 ||
      !PART_FILE_RE.test(part.file)
    ) {
      throw new ExternalServiceError('invalid-response', 'pack release index has an invalid part');
    }
    files.add(part.file);
    totalBytes += part.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.corpusBytes) {
      throw new ExternalServiceError(
        'response-too-large',
        'pack release exceeds the corpus size limit',
      );
    }
  }
  if (totalBytes !== idx.totalBytes) {
    throw new ExternalServiceError(
      'integrity',
      'pack release index total does not match its declared parts',
    );
  }
  return idx as PackReleaseIndex;
}

/** Async generator concatenating part files in order into one byte stream. */
async function* concatParts(paths: string[]): AsyncGenerator<Buffer> {
  for (const path of paths) {
    for await (const chunk of createReadStream(path)) {
      yield chunk as Buffer;
    }
  }
}

async function hashParts(paths: string[], signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of concatParts(paths)) {
    if (signal?.aborted) {
      throw new ExternalServiceError('cancelled', 'pack verification was cancelled');
    }
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function oneAsset(candidate: ReleaseCandidate, name: string): GithubAsset {
  const matches = candidate.assets.get(name) ?? [];
  if (matches.length !== 1) {
    throw new ExternalServiceError(
      matches.length === 0 ? 'trust' : 'ambiguous',
      matches.length === 0
        ? 'selected GitHub release does not contain every indexed corpus asset'
        : 'selected GitHub release contains duplicate corpus assets',
    );
  }
  return matches[0];
}

/**
 * Downloads, verifies, and installs a multi-part pack release. Throws
 * `PackInstallError` on any download or integrity failure (installing nothing).
 */
export async function pullPack(opts: PullPackOptions): Promise<PulledPack> {
  const automaticDiscovery = !opts.baseUrl && !opts.tag;
  const noVerify = opts.noVerify ?? false;
  const transportOptions: ExternalTransportOptions = {
    signal: opts.signal,
    limits: opts.externalLimits,
    fetch: opts.fetch,
  };
  const discovery = automaticDiscovery
    ? await discoverLatestPackRelease(
        opts.name,
        opts.repo ?? DEFAULT_PACK_REPO,
        !noVerify,
        createExternalContext(
          transportOptions,
          opts.externalLimits?.discoveryTimeoutMs ?? DEFAULT_EXTERNAL_LIMITS.discoveryTimeoutMs,
        ),
      )
    : undefined;
  const base = discovery?.baseUrl ?? resolvePackBaseUrl(opts);
  const transport = createExternalContext(
    transportOptions,
    opts.externalLimits?.pullTimeoutMs ?? DEFAULT_EXTERNAL_LIMITS.pullTimeoutMs,
  );
  const policy =
    discovery || opts.tag ? { allowedOrigins: GITHUB_ASSET_ORIGINS } : exactOriginPolicy(base);
  const indexName = `${opts.name}${PACK_RELEASE_INDEX_SUFFIX}`;
  const indexUrl = discovery ? oneAsset(discovery, indexName).url : `${base}/${indexName}`;
  const log = opts.log ?? ((message: string) => process.stderr.write(`${message}\n`));

  // Fetch the RAW index bytes and verify authenticity BEFORE parsing the JSON, so
  // a tampered index cannot influence the client before its signature is checked.
  const indexBytes = (await fetchBoundedBytes(
    transport,
    indexUrl,
    policy,
    transport.limits.indexBytes,
    'pack index download',
  )) as Buffer;
  const signatureName = `${indexName}${PACK_RELEASE_SIGNATURE_SUFFIX}`;
  const signatureUrl = discovery
    ? (discovery.assets.get(signatureName)?.[0]?.url ?? `${base}/${signatureName}`)
    : `${indexUrl}${PACK_RELEASE_SIGNATURE_SUFFIX}`;
  const signatureBytes = await fetchBoundedBytes(
    transport,
    signatureUrl,
    policy,
    transport.limits.signatureBytes,
    'pack signature download',
    { optional404: true },
  );
  const sigText = signatureBytes?.toString('utf8') ?? null;
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
    throw new ExternalServiceError(
      'trust',
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

  const index = assertIndex(parseIndexJson(indexBytes), opts.name, transport.limits);
  if (discovery && index.version !== discovery.version) {
    throw new ExternalServiceError(
      'trust',
      'signed pack index version does not match the selected GitHub release tag',
    );
  }

  const work = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), 'kgpacks-pull-'));
  try {
    const partPaths: string[] = [];
    for (const part of index.parts) {
      if (opts.signal?.aborted) {
        throw new ExternalServiceError('cancelled', 'pack retrieval was cancelled');
      }
      const dest = join(work, part.file);
      const asset = discovery ? oneAsset(discovery, part.file) : undefined;
      if (asset?.size !== undefined && asset.size !== part.bytes) {
        throw new ExternalServiceError(
          'integrity',
          `part ${part.file} size does not match GitHub release metadata`,
        );
      }
      const { sha256, bytes } = await downloadBoundedFile(
        transport,
        asset?.url ?? `${base}/${part.file}`,
        policy,
        dest,
        part.bytes,
        `corpus part ${part.file} download`,
      );
      if (bytes !== part.bytes) {
        throw new ExternalServiceError(
          'integrity',
          `part ${part.file} size mismatch: expected ${part.bytes} bytes, got ${bytes}`,
        );
      }
      if (sha256 !== part.sha256) {
        throw new ExternalServiceError('integrity', `part ${part.file} checksum mismatch`);
      }
      partPaths.push(dest);
    }

    if ((await hashParts(partPaths, opts.signal)) !== index.sha256) {
      throw new ExternalServiceError(
        'integrity',
        `assembled archive for ${opts.name} failed overall checksum`,
      );
    }

    if (opts.signal?.aborted) {
      throw new ExternalServiceError('cancelled', 'pack installation was cancelled');
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
