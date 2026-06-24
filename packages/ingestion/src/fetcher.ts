// @kgpacks/ingestion — SSRF-safe content fetcher.
//
// Ports the reference `_validate_url` (bootstrap/src/sources/web module) and hardens
// it with redirect re-validation. Every URL — the seed and every redirect hop — is
// validated BEFORE a connection is made:
//   1. scheme MUST be https (no http/file/ftp/gopher/…);
//   2. embedded credentials (user:pass@host) are rejected;
//   3. the host is resolved (DNS) and EVERY resulting address must be public —
//      any private / loopback / link-local / reserved / multicast address (IPv4
//      or IPv6, including IPv4-mapped IPv6 and the 169.254.169.254 cloud-metadata
//      endpoint) fails closed.
// Redirects are followed manually so each hop re-runs the full gate, defeating
// redirect-to-internal pivots. Hops are bounded.
//
// NOTE: the default connector uses the platform `fetch`, which re-resolves DNS at
// connect time — leaving a narrow DNS-rebinding TOCTOU window after validation.
// For an operator-driven build tool this residual risk is acceptable; callers can
// inject `fetchImpl` with an IP-pinning connector (dial the exact validated
// address, keep the hostname for TLS SNI) to close it entirely.
//
// The DNS `lookup` and low-level `fetch` are injectable seams so the negative
// tests exercise the blocklist deterministically with zero real network I/O.

import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

import { BlockedUrlError, FetchError } from './errors.js';
import type {
  Fetcher,
  FetchImpl,
  FetchInit,
  FetchResponse,
  LookupFn,
  ResolvedAddress,
} from './types.js';

const DEFAULT_USER_AGENT = 'kgpacks-ingestion/0.0 (+knowledge-graph-builder)';
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB

/** Options for {@link createSafeFetcher}. */
export interface SafeFetcherOptions {
  /** Low-level fetch. Defaults to the platform `fetch`. */
  fetchImpl?: FetchImpl;
  /** DNS resolver. Defaults to `node:dns/promises` `lookup` (all addresses). */
  lookup?: LookupFn;
  /** Maximum redirect hops to follow (each re-validated). Default 5. */
  maxRedirects?: number;
  /** `User-Agent` header sent with every request. */
  userAgent?: string;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Maximum response body size in bytes (fail closed when exceeded). Default 25 MiB. */
  maxBytes?: number;
}

/** Releases an unconsumed response body (best-effort) so the socket isn't held until GC. */
async function drainBody(response: FetchResponse): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort: a body that cannot be cancelled is not actionable here.
  }
}

/**
 * Reads a response body as text, enforcing a hard byte cap. Uses the raw stream
 * when available (true streaming, so an oversized body is rejected mid-read before
 * it is fully buffered); falls back to `text()` with a post-read size check for
 * test doubles that omit `body`.
 */
async function readBodyCapped(
  response: FetchResponse,
  maxBytes: number,
  url: string,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await drainBody(response);
    throw new FetchError(
      `Response body too large for ${url}: ${declared} bytes exceeds cap ${maxBytes}`,
      url,
      response.status,
    );
  }

  const stream = response.body;
  if (stream == null) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new FetchError(`Response body exceeds cap ${maxBytes} bytes for ${url}`, url);
    }
    return text;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new FetchError(
            `Response body exceeds cap ${maxBytes} bytes for ${url}`,
            url,
            response.status,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parsed IP address as raw bytes, tagged by family. */
interface ParsedIp {
  family: 4 | 6;
  bytes: Uint8Array;
}

/** Parses a syntactically-valid IPv4/IPv6 literal into its raw bytes. */
function parseIp(addr: string): ParsedIp | null {
  const version = isIP(addr);
  if (version === 4) {
    const parts = addr.split('.').map((p) => Number.parseInt(p, 10));
    return { family: 4, bytes: Uint8Array.from(parts) };
  }
  if (version === 6) {
    return { family: 6, bytes: ipv6ToBytes(addr) };
  }
  return null;
}

/** Expands a valid IPv6 literal (with `::` and optional embedded IPv4) to 16 bytes. */
function ipv6ToBytes(addr: string): Uint8Array {
  const zone = addr.indexOf('%');
  if (zone >= 0) {
    addr = addr.slice(0, zone);
  }

  let head: string[];
  let tail: string[];
  if (addr.includes('::')) {
    const [h, t] = addr.split('::');
    head = h.length > 0 ? h.split(':') : [];
    tail = t.length > 0 ? t.split(':') : [];
  } else {
    head = addr.split(':');
    tail = [];
  }

  const toHextets = (groups: string[]): number[] => {
    const out: number[] = [];
    for (const group of groups) {
      if (group.includes('.')) {
        const v4 = group.split('.').map((p) => Number.parseInt(p, 10));
        out.push(((v4[0] << 8) | v4[1]) & 0xffff, ((v4[2] << 8) | v4[3]) & 0xffff);
      } else {
        out.push(Number.parseInt(group, 16) & 0xffff);
      }
    }
    return out;
  };

  const headH = toHextets(head);
  const tailH = toHextets(tail);
  const missing = Math.max(0, 8 - headH.length - tailH.length);
  const full = [...headH, ...Array<number>(missing).fill(0), ...tailH];

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const hextet = full[i] ?? 0;
    bytes[i * 2] = (hextet >> 8) & 0xff;
    bytes[i * 2 + 1] = hextet & 0xff;
  }
  return bytes;
}

/** True if an IPv4 address (4 bytes) falls in any non-public range. */
function isBlockedIpv4(b: Uint8Array): boolean {
  const [a, c, d] = [b[0], b[1], b[2]];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && c === 254) return true; // 169.254.0.0/16 link-local (+ metadata)
  if (a === 172 && c >= 16 && c <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && c === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && c >= 64 && c <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && c === 0 && d === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && c === 0 && d === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (c === 18 || c === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && c === 51 && d === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && c === 0 && d === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false;
}

/** True if an IPv6 address (16 bytes) falls in any non-public range. */
function isBlockedIpv6(b: Uint8Array): boolean {
  const allZeroUpTo = (n: number): boolean => b.subarray(0, n).every((x) => x === 0);

  if (allZeroUpTo(16)) return true; // :: unspecified
  if (allZeroUpTo(15) && b[15] === 1) return true; // ::1 loopback
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 docs

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): re-check the v4 tail.
  const mapped = allZeroUpTo(10) && b[10] === 0xff && b[11] === 0xff;
  const compat = allZeroUpTo(12) && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] <= 1);
  if (mapped || compat) {
    return isBlockedIpv4(b.subarray(12, 16));
  }
  return false;
}

/** True if a resolved address string is not a publicly-routable destination. */
export function isBlockedAddress(addr: string): boolean {
  const parsed = parseIp(addr);
  if (parsed === null) {
    return true; // unparseable ⇒ fail closed
  }
  return parsed.family === 4 ? isBlockedIpv4(parsed.bytes) : isBlockedIpv6(parsed.bytes);
}

/**
 * Validates a single URL against the SSRF gate. Throws {@link BlockedUrlError}
 * when the scheme is not https, credentials are embedded, the host is missing, or
 * the host resolves to any non-public address.
 */
export async function assertUrlAllowed(rawUrl: string, lookup: LookupFn): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`Malformed URL: ${rawUrl}`, rawUrl);
  }

  if (url.protocol !== 'https:') {
    throw new BlockedUrlError(
      `Only https URLs are allowed (got ${url.protocol || 'no scheme'})`,
      rawUrl,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new BlockedUrlError('URLs with embedded credentials are not allowed', rawUrl);
  }
  const host = url.hostname;
  if (host === '') {
    throw new BlockedUrlError('URL has no host', rawUrl);
  }

  // A literal-IP host needs no resolution; check it directly.
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new BlockedUrlError(`URL host is a non-public address: ${host}`, rawUrl);
    }
    return;
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(host);
  } catch (err) {
    throw new BlockedUrlError(`Cannot resolve host ${host}: ${(err as Error).message}`, rawUrl);
  }
  if (addresses.length === 0) {
    throw new BlockedUrlError(`Host ${host} resolved to no addresses`, rawUrl);
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new BlockedUrlError(
        `Host ${host} resolves to a non-public address: ${address}`,
        rawUrl,
      );
    }
  }
}

/** Default DNS resolver: `node:dns/promises` `lookup` returning all addresses. */
const defaultLookup: LookupFn = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
};

/**
 * Builds an SSRF-safe {@link Fetcher}. The returned function validates the URL,
 * follows redirects manually (re-validating each hop, up to `maxRedirects`), and
 * resolves with the final 2xx response body text.
 */
export function createSafeFetcher(options: SafeFetcherOptions = {}): Fetcher {
  // NOTE: the default connector re-resolves DNS at connect time, leaving a narrow
  // DNS-rebinding TOCTOU window after assertUrlAllowed(). For an operator-driven
  // build tool this is acceptable; inject fetchImpl with an IP-pinning connector
  // to fully close it. assertUrlAllowed() still guards every hop (incl. redirects).
  const fetchImpl: FetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  const lookup = options.lookup ?? defaultLookup;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  if (typeof fetchImpl !== 'function') {
    throw new FetchError('No fetch implementation available', '');
  }

  return async function safeFetch(initialUrl: string): Promise<string> {
    let currentUrl = initialUrl;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertUrlAllowed(currentUrl, lookup);

      const controller = new AbortController();
      // The timer stays armed across the body read (cleared only in finally), so a
      // slow-drip body is aborted by the timeout, not just the header exchange.
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Awaited<ReturnType<FetchImpl>>;
        try {
          const init: FetchInit = {
            redirect: 'manual',
            headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' },
            signal: controller.signal,
          };
          response = await fetchImpl(currentUrl, init);
        } catch (err) {
          throw new FetchError(
            `Fetch failed for ${currentUrl}: ${(err as Error).message}`,
            currentUrl,
          );
        }

        const status = response.status;
        if (status >= 300 && status < 400) {
          const location = response.headers.get('location');
          await drainBody(response); // release the connection before the next hop
          if (location === null || location === '') {
            throw new FetchError(
              `Redirect ${status} without a Location header`,
              currentUrl,
              status,
            );
          }
          // Resolve relative redirects against the current URL, then re-validate.
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        if (status < 200 || status >= 300) {
          await drainBody(response);
          throw new FetchError(
            `Unexpected HTTP status ${status} for ${currentUrl}`,
            currentUrl,
            status,
          );
        }
        return await readBodyCapped(response, maxBytes, currentUrl);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new FetchError(
      `Too many redirects (> ${maxRedirects}) starting from ${initialUrl}`,
      initialUrl,
    );
  };
}
