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
}

const API_PREFIX = '/api/v1';

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

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? defaultBaseUrl();
    this.fetchImpl =
      options.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    this.eventSourceFactory =
      options.eventSourceFactory ??
      ((url: string) => new EventSource(url) as unknown as EventSourceLike);
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
    let response: Response;
    try {
      response = await this.fetchImpl(url, { credentials: 'omit' });
    } catch {
      throw new ApiClientError('NETWORK_ERROR', 'The network request failed.', null);
    }
    return (await response.json()) as HealthResponse;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────────

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${API_PREFIX}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { credentials: 'omit', ...init });
    } catch {
      throw new ApiClientError('NETWORK_ERROR', 'The network request failed.', null);
    }
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    return (await response.json()) as T;
  }
}
