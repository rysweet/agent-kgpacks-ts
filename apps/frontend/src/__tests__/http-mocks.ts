// apps/frontend/src/__tests__/http-mocks.ts
//
// Offline HTTP test doubles for the ApiClient unit suites: a minimal `Response`
// factory, a call-capturing fake `fetch`, and a header-reading helper that works
// regardless of how the client expresses request headers (plain object / tuple
// array / `Headers`). No real network is ever touched.

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** A minimal `Response` whose `json()` resolves `body`. */
export function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const ok = status >= 200 && status < 300;
  const response = {
    ok,
    status,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    json: async (): Promise<unknown> => body,
    text: async (): Promise<string> => JSON.stringify(body),
  };
  return response as unknown as Response;
}

/** A non-JSON `Response` whose `json()` rejects — exercises the status→code fallback. */
export function textResponse(text: string, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const ok = status >= 200 && status < 300;
  const response = {
    ok,
    status,
    headers: { get: (): string | null => 'text/plain' },
    json: async (): Promise<unknown> => {
      throw new SyntaxError('Unexpected token in JSON');
    },
    text: async (): Promise<string> => text,
  };
  return response as unknown as Response;
}

/** A `fetch` test double that records every call and delegates to `handler`. */
export function makeFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const call: FetchCall = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

/** Reads a single header value from any `HeadersInit` shape. */
export function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === lower);
    return found ? found[1] : null;
  }
  const maybeGet = (headers as { get?: unknown }).get;
  if (typeof maybeGet === 'function') {
    return (headers as { get(headerName: string): string | null }).get(name);
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === lower);
  return key ? record[key] : null;
}
