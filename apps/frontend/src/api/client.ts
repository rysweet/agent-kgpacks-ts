// apps/frontend/src/api/client.ts
//
// The single public network seam: a typed client over `fetch` for the backend's
// `/api/v1` blocking endpoints, plus `streamChat` over an injectable
// `EventSource`. Paths are joined as `${baseUrl}/api/v1/...`; every query/path
// value is URL-encoded; any non-2xx response becomes an `ApiClientError`.
// See docs/packages/frontend.md#api-client-reference.

import { ApiClientError, errorFromResponse } from './errors';
import { openChatStream } from './sse';
import type { EventSourceLike, StreamController, StreamHandlers } from './sse';
import type {
  ArticleDetail,
  AutocompleteResponse,
  CategoriesResponse,
  ChatRequest,
  ChatResponse,
  GraphResponse,
  HealthResponse,
  SearchResponse,
  StatsResponse,
  StreamChatRequest,
} from './types';

export interface ApiClientOptions {
  /** Base URL prefix. Defaults to `import.meta.env.VITE_API_BASE_URL ?? ''`. */
  baseUrl?: string;
  /** Injectable fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Injectable EventSource constructor for streamChat. Defaults to `globalThis.EventSource`. */
  eventSourceFactory?: (url: string) => EventSourceLike;
  /** Per-attempt timeout for blocking HTTP calls. Default 15000ms. */
  timeoutMs?: number;
  /** Retries for transient idempotent HTTP failures. Default 2. */
  maxRetries?: number;
  /** Initial exponential-backoff delay. Default 250ms. */
  retryBaseDelayMs?: number;
}

const API_PREFIX = '/api/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function defaultBaseUrl(): string {
  // `import.meta.env` is provided by Vite; guard for non-Vite runtimes.
  try {
    return import.meta.env?.VITE_API_BASE_URL ?? '';
  } catch {
    return '';
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly eventSourceFactory: (url: string) => EventSourceLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? defaultBaseUrl();
    this.fetchImpl =
      options.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    this.eventSourceFactory =
      options.eventSourceFactory ??
      ((url: string) => new EventSource(url) as unknown as EventSourceLike);
    this.timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxRetries = nonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES);
    this.retryBaseDelayMs = nonNegativeNumber(
      options.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
    );
  }

  // ─── Chat ──────────────────────────────────────────────────────────────────

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      question: req.question,
      max_results: req.max_results ?? 10,
    };
    if (req.pack !== undefined) body.pack = req.pack;
    return this.request<ChatResponse>('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  streamChat(req: StreamChatRequest, handlers: StreamHandlers): StreamController {
    const params = new URLSearchParams();
    params.set('question', req.question);
    params.set('max_results', String(req.max_results ?? 10));
    const url = `${this.baseUrl}${API_PREFIX}/chat/stream?${params.toString()}`;
    return openChatStream(this.eventSourceFactory, url, handlers);
  }

  // ─── Search / graph / articles ───────────────────────────────────────────────

  async search(params: {
    query: string;
    category?: string;
    limit?: number;
    threshold?: number;
  }): Promise<SearchResponse> {
    const query = new URLSearchParams();
    query.set('query', params.query);
    if (params.category !== undefined) query.set('category', params.category);
    query.set('limit', String(params.limit ?? 10));
    query.set('threshold', String(params.threshold ?? 0));
    return this.request<SearchResponse>(`/search?${query.toString()}`);
  }

  async hybridSearch(params: {
    query: string;
    category?: string;
    max_hops?: number;
    limit?: number;
  }): Promise<SearchResponse> {
    const query = new URLSearchParams();
    query.set('query', params.query);
    if (params.category !== undefined) query.set('category', params.category);
    query.set('max_hops', String(params.max_hops ?? 2));
    query.set('limit', String(params.limit ?? 10));
    return this.request<SearchResponse>(`/hybrid-search?${query.toString()}`);
  }

  async graph(params: {
    article: string;
    depth?: number;
    limit?: number;
    category?: string;
  }): Promise<GraphResponse> {
    const query = new URLSearchParams();
    query.set('article', params.article);
    query.set('depth', String(params.depth ?? 2));
    query.set('limit', String(params.limit ?? 50));
    if (params.category !== undefined) query.set('category', params.category);
    return this.request<GraphResponse>(`/graph?${query.toString()}`);
  }

  async getArticle(title: string): Promise<ArticleDetail> {
    return this.request<ArticleDetail>(`/articles/${encodeURIComponent(title)}`);
  }

  // ─── Supporting endpoints ─────────────────────────────────────────────────────

  async autocomplete(params: { q: string; limit?: number }): Promise<AutocompleteResponse> {
    const query = new URLSearchParams();
    query.set('q', params.q);
    query.set('limit', String(params.limit ?? 10));
    return this.request<AutocompleteResponse>(`/autocomplete?${query.toString()}`);
  }

  async categories(): Promise<CategoriesResponse> {
    return this.request<CategoriesResponse>('/categories');
  }

  async stats(): Promise<StatsResponse> {
    return this.request<StatsResponse>('/stats');
  }

  /** Resolves the body for BOTH 200 (healthy) and 503 (unhealthy) — never throws on status. */
  async health(): Promise<HealthResponse> {
    // `/health` is served UNPREFIXED by the backend (not under /api/v1).
    const url = `${this.baseUrl}/health`;
    return this.fetchJson<HealthResponse>(url, { credentials: 'omit' }, (response) => {
      return response.ok || response.status === 503;
    });
  }

  // ─── Internal ─────────────────────────────────────────────────────────────────

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${API_PREFIX}${path}`;
    return this.fetchJson<T>(url, { credentials: 'omit', ...init });
  }

  private async fetchJson<T>(
    url: string,
    init: RequestInit,
    accepts: (response: Response) => boolean = (response) => response.ok,
  ): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const canRetry = method === 'GET' || method === 'HEAD';
    const retries = canRetry ? this.maxRetries : 0;

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      const callerSignal = init.signal;
      const abortFromCaller = (): void => controller.abort(callerSignal?.reason);
      if (callerSignal?.aborted) abortFromCaller();
      else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
      const cleanup = (): void => {
        clearTimeout(timeout);
        callerSignal?.removeEventListener('abort', abortFromCaller);
      };

      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      } catch {
        cleanup();
        if (attempt < retries && !callerSignal?.aborted) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        if (timedOut) {
          throw new ApiClientError('TIMEOUT', 'The network request timed out.', null);
        }
        throw new ApiClientError('NETWORK_ERROR', 'The network request failed.', null);
      }

      if (accepts(response)) {
        try {
          return (await response.json()) as T;
        } catch {
          if (timedOut) {
            throw new ApiClientError('TIMEOUT', 'The network request timed out.', null);
          }
          throw new ApiClientError(
            'INTERNAL_ERROR',
            'The service returned an invalid JSON response.',
            response.status,
          );
        } finally {
          cleanup();
        }
      }
      if (attempt < retries && RETRYABLE_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        cleanup();
        await this.waitBeforeRetry(attempt, response.headers.get('retry-after'));
        continue;
      }
      try {
        const error = await errorFromResponse(response);
        if (timedOut) {
          throw new ApiClientError('TIMEOUT', 'The network request timed out.', null);
        }
        throw error;
      } finally {
        cleanup();
      }
    }
  }

  private async waitBeforeRetry(attempt: number, retryAfter?: string | null): Promise<void> {
    const serverDelay = parseRetryAfter(retryAfter);
    const exponential = this.retryBaseDelayMs * 2 ** attempt;
    const delay = Math.min(MAX_RETRY_DELAY_MS, serverDelay ?? exponential);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
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

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}
