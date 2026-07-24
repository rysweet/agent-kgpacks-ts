import { createHash } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PackInstallError } from '@kgpacks/packs';

export type ExternalErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'transport'
  | 'http'
  | 'redirect'
  | 'origin'
  | 'response-too-large'
  | 'invalid-response'
  | 'not-found'
  | 'ambiguous'
  | 'trust'
  | 'integrity';

export class ExternalServiceError extends PackInstallError {
  readonly code: ExternalErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: ExternalErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'ExternalServiceError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface ExternalServiceLimits {
  maxRedirects: number;
  requestTimeoutMs: number;
  discoveryTimeoutMs: number;
  pullTimeoutMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  maxRetryAfterMs: number;
  discoveryMaxPages: number;
  discoveryPageBytes: number;
  indexBytes: number;
  signatureBytes: number;
  corpusBytes: number;
  maxParts: number;
}

export const DEFAULT_EXTERNAL_LIMITS: Readonly<ExternalServiceLimits> = Object.freeze({
  maxRedirects: 5,
  requestTimeoutMs: 30_000,
  discoveryTimeoutMs: 120_000,
  pullTimeoutMs: 2 * 60 * 60 * 1_000,
  maxAttempts: 3,
  retryBaseDelayMs: 250,
  maxRetryAfterMs: 30_000,
  discoveryMaxPages: 10,
  discoveryPageBytes: 8 * 1024 * 1024,
  indexBytes: 8 * 1024 * 1024,
  signatureBytes: 64 * 1024,
  corpusBytes: 32 * 1024 * 1024 * 1024,
  maxParts: 10_000,
});

export type ExternalFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ExternalTransportOptions {
  signal?: AbortSignal;
  limits?: Partial<ExternalServiceLimits>;
  fetch?: ExternalFetch;
}

export interface ExternalContext {
  readonly signal?: AbortSignal;
  readonly limits: ExternalServiceLimits;
  readonly fetch: ExternalFetch;
  readonly deadline: number;
}

export interface TransportPolicy {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowHttp?: boolean;
}

export interface BoundedFetchOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly optional404?: boolean;
}

export const GITHUB_ASSET_ORIGINS: ReadonlySet<string> = new Set([
  'https://github.com',
  'https://objects.githubusercontent.com',
  'https://release-assets.githubusercontent.com',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const LOCAL_WRITE_ERROR_CODES = new Set([
  'EACCES',
  'EDQUOT',
  'EEXIST',
  'EFBIG',
  'EIO',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'EROFS',
]);

export function createExternalContext(
  options: ExternalTransportOptions,
  timeoutMs: number,
): ExternalContext {
  const limits = { ...DEFAULT_EXTERNAL_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ExternalServiceError('invalid-response', `invalid external-service limit ${key}`);
    }
  }
  if (limits.maxAttempts < 1 || limits.maxAttempts > 3) {
    throw new ExternalServiceError(
      'invalid-response',
      'external-service attempts must be between one and three',
    );
  }
  if (limits.discoveryMaxPages < 1) {
    throw new ExternalServiceError(
      'invalid-response',
      'external-service discovery must allow at least one page',
    );
  }
  if (timeoutMs <= 0) {
    throw new ExternalServiceError('timeout', 'external operation timed out');
  }
  return {
    signal: options.signal,
    limits,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    deadline: Date.now() + timeoutMs,
  };
}

export function exactOriginPolicy(url: string): TransportPolicy {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ExternalServiceError('origin', 'external source URL is invalid');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ExternalServiceError('origin', 'external source must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new ExternalServiceError('origin', 'external source URL must not contain credentials');
  }
  return {
    allowedOrigins: new Set([parsed.origin]),
    allowHttp: parsed.protocol === 'http:',
  };
}

export async function fetchBoundedBytes(
  context: ExternalContext,
  url: string,
  policy: TransportPolicy,
  maxBytes: number,
  operation: string,
  options: BoundedFetchOptions = {},
): Promise<Buffer | null> {
  return withRetries(context, operation, async () => {
    const active = await requestFollowingRedirects(
      context,
      url,
      policy,
      operation,
      options.headers,
    );
    try {
      if (options.optional404 && active.response.status === 404) {
        await active.response.body?.cancel();
        return null;
      }
      if (!active.response.ok) await active.response.body?.cancel();
      assertSuccessfulStatus(active.response, operation);
      return await readBoundedBody(context, active.response, maxBytes, operation);
    } finally {
      active.finish();
    }
  });
}

export async function downloadBoundedFile(
  context: ExternalContext,
  url: string,
  policy: TransportPolicy,
  destination: string,
  maxBytes: number,
  operation: string,
): Promise<{ bytes: number; sha256: string }> {
  return withRetries(context, operation, async () => {
    rmSync(destination, { force: true });
    const active = await requestFollowingRedirects(context, url, policy, operation);
    try {
      if (!active.response.ok) await active.response.body?.cancel();
      assertSuccessfulStatus(active.response, operation);
      if (!active.response.body) {
        throw new ExternalServiceError(
          'invalid-response',
          `${operation} returned no response body`,
        );
      }
      assertContentLength(active.response, maxBytes, operation);
      const hash = createHash('sha256');
      let bytes = 0;
      const verifier = new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            callback(
              new ExternalServiceError(
                'response-too-large',
                `${operation} exceeded its size limit`,
              ),
            );
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(active.response.body as Parameters<typeof Readable.fromWeb>[0]),
          verifier,
          createWriteStream(destination),
        );
      } catch (error) {
        rmSync(destination, { force: true });
        if (error instanceof ExternalServiceError) throw error;
        if (isLocalWriteError(error)) {
          throw new PackInstallError('cannot write downloaded corpus part');
        }
        throw mapTransportFailure(context, operation);
      }
      return { bytes, sha256: hash.digest('hex') };
    } finally {
      active.finish();
    }
  });
}

interface ActiveResponse {
  response: Response;
  finish: () => void;
}

async function requestFollowingRedirects(
  context: ExternalContext,
  initialUrl: string,
  policy: TransportPolicy,
  operation: string,
  headers?: Readonly<Record<string, string>>,
): Promise<ActiveResponse> {
  let current = assertAllowedUrl(initialUrl, policy);
  for (let redirects = 0; ; redirects++) {
    const active = await requestOnce(context, current, operation, headers);
    if (!REDIRECT_STATUSES.has(active.response.status)) return active;

    const location = active.response.headers.get('location');
    await active.response.body?.cancel();
    active.finish();
    if (!location) {
      throw new ExternalServiceError(
        'redirect',
        `${operation} returned a redirect without a location`,
      );
    }
    if (redirects >= context.limits.maxRedirects) {
      throw new ExternalServiceError('redirect', `${operation} exceeded its redirect limit`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new ExternalServiceError('redirect', `${operation} returned an invalid redirect`);
    }
    current = assertAllowedUrl(next.toString(), policy);
  }
}

function assertAllowedUrl(value: string, policy: TransportPolicy): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExternalServiceError('origin', 'external request URL is invalid');
  }
  if (url.username || url.password) {
    throw new ExternalServiceError('origin', 'external request URL must not contain credentials');
  }
  const allowedProtocol =
    url.protocol === 'https:' || (policy.allowHttp && url.protocol === 'http:');
  if (!allowedProtocol || !policy.allowedOrigins.has(url.origin)) {
    throw new ExternalServiceError('origin', 'external request origin is not approved');
  }
  return url;
}

async function requestOnce(
  context: ExternalContext,
  url: URL,
  operation: string,
  headers?: Readonly<Record<string, string>>,
): Promise<ActiveResponse> {
  throwIfStopped(context);
  const remaining = context.deadline - Date.now();
  if (remaining <= 0) throw timeoutError(operation);

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.min(context.limits.requestTimeoutMs, remaining),
  );
  const cancel = () => controller.abort();
  context.signal?.addEventListener('abort', cancel, { once: true });
  const finish = () => {
    clearTimeout(timeout);
    context.signal?.removeEventListener('abort', cancel);
  };

  try {
    const response = await context.fetch(url, {
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    return { response, finish };
  } catch {
    finish();
    if (context.signal?.aborted) throw cancelledError(operation);
    if (timedOut || Date.now() >= context.deadline) throw timeoutError(operation);
    throw new ExternalServiceError('transport', `${operation} failed`, { retryable: true });
  }
}

async function readBoundedBody(
  context: ExternalContext,
  response: Response,
  maxBytes: number,
  operation: string,
): Promise<Buffer> {
  assertContentLength(response, maxBytes, operation);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ExternalServiceError(
          'response-too-large',
          `${operation} exceeded its size limit`,
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ExternalServiceError) throw error;
    throw mapTransportFailure(context, operation);
  }
  return Buffer.concat(chunks, bytes);
}

function assertContentLength(response: Response, maxBytes: number, operation: string): void {
  const value = response.headers.get('content-length');
  if (value === null) return;
  if (!/^\d+$/.test(value)) {
    throw new ExternalServiceError(
      'invalid-response',
      `${operation} returned an invalid content length`,
    );
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
    throw new ExternalServiceError('response-too-large', `${operation} exceeded its size limit`);
  }
}

function assertSuccessfulStatus(response: Response, operation: string): void {
  if (response.ok) return;
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
  const retryable = rateLimited || TRANSIENT_STATUSES.has(response.status);
  throw new ExternalServiceError('http', `${operation} failed (HTTP ${response.status})`, {
    status: response.status,
    retryable,
    retryAfterMs: retryable ? retryAfterMs(response.headers.get('retry-after')) : undefined,
  });
}

async function withRetries<T>(
  context: ExternalContext,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    throwIfStopped(context);
    try {
      return await action();
    } catch (error) {
      if (
        !(error instanceof ExternalServiceError) ||
        !error.retryable ||
        attempt >= context.limits.maxAttempts
      ) {
        throw error;
      }
      const exponential = context.limits.retryBaseDelayMs * 2 ** (attempt - 1);
      const requested = error.retryAfterMs ?? exponential;
      const delay = Math.min(requested, context.limits.maxRetryAfterMs);
      await cancellableDelay(context, delay, operation);
    }
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1_000;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return undefined;
  return Math.max(0, instant - Date.now());
}

async function cancellableDelay(
  context: ExternalContext,
  delayMs: number,
  operation: string,
): Promise<void> {
  throwIfStopped(context);
  if (delayMs <= 0) return;
  if (Date.now() + delayMs > context.deadline) throw timeoutError(operation);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    const cancel = () => {
      cleanup();
      reject(cancelledError(operation));
    };
    function cleanup(): void {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', cancel);
    }
    function done(): void {
      cleanup();
      resolve();
    }
    context.signal?.addEventListener('abort', cancel, { once: true });
  });
}

function throwIfStopped(context: ExternalContext): void {
  if (context.signal?.aborted) throw cancelledError('external operation');
  if (Date.now() >= context.deadline) throw timeoutError('external operation');
}

function mapTransportFailure(context: ExternalContext, operation: string): ExternalServiceError {
  if (context.signal?.aborted) return cancelledError(operation);
  if (Date.now() >= context.deadline) return timeoutError(operation);
  return new ExternalServiceError('transport', `${operation} failed`, { retryable: true });
}

function cancelledError(operation: string): ExternalServiceError {
  return new ExternalServiceError('cancelled', `${operation} was cancelled`);
}

function timeoutError(operation: string): ExternalServiceError {
  return new ExternalServiceError('timeout', `${operation} timed out`);
}

function isLocalWriteError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && LOCAL_WRITE_ERROR_CODES.has(code);
}
