// apps/frontend/src/__tests__/streamChat.test.ts
//
// TDD contract for `ApiClient.streamChat` over the injectable EventSource seam
// (RED until src/api/client.ts / src/api/sse.ts exist).
//
// Asserts, per docs/packages/frontend.md#streamchat-sse and #error-model:
//   - GET /api/v1/chat/stream with the question + max_results encoded into the URL,
//   - the success ordering sources → token → done, with `onToken` CONCATENATING,
//   - the connection is closed exactly once after `done`,
//   - the IN-STREAM error path: `error`/`TimeoutError` → TIMEOUT,
//     `error`/`AgentError` → AGENT_ERROR (status null),
//   - the PRE-STREAM path: an `onerror` before any named event → NETWORK_ERROR
//     (the browser EventSource cannot expose the backend's pre-stream 503 status),
//   - `controller.close()` idempotency (close fires exactly once), and
//   - guarded `JSON.parse` (a malformed `sources` payload becomes an
//     ApiClientError, never an unhandled throw).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClient, type ApiClientOptions } from '../api/client';
import { ApiClientError } from '../api/errors';

import { FakeEventSource, lastFakeEventSource, resetFakeEventSources } from './fake-event-source';

type Factory = NonNullable<ApiClientOptions['eventSourceFactory']>;
const eventSourceFactory = ((url: string) => new FakeEventSource(url)) as unknown as Factory;

function streamClient(): ApiClient {
  return new ApiClient({ baseUrl: 'http://api.test', eventSourceFactory });
}

beforeEach(() => {
  resetFakeEventSources();
});

describe('streamChat — request URL', () => {
  it('opens GET /api/v1/chat/stream with question + max_results encoded into the query', () => {
    const api = streamClient();
    api.streamChat({ question: 'a & b = c?', max_results: 8 }, {});

    const es = lastFakeEventSource();
    const url = new URL(es.url);
    expect(url.pathname).toBe('/api/v1/chat/stream');
    expect(url.searchParams.get('question')).toBe('a & b = c?');
    expect(url.searchParams.get('max_results')).toBe('8');
    // The literal reserved characters must not leak unencoded into the URL.
    expect(es.url).not.toContain('a & b = c?');
  });
});

describe('streamChat — success path', () => {
  it('dispatches sources → token → done, concatenates tokens, and closes after done', () => {
    const onSources = vi.fn();
    const onToken = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const api = streamClient();
    const controller = api.streamChat(
      { question: 'What is entanglement?', max_results: 8 },
      { onSources, onToken, onDone, onError },
    );
    const es = lastFakeEventSource();

    es.emit('sources', JSON.stringify(['Quantum entanglement', "Bell's theorem"]));
    es.emit('token', 'Entanglement ');
    es.emit('token', 'links particles.');
    es.emit('done', JSON.stringify({ query_type: 'vector_search', execution_time_ms: 842 }));

    expect(onSources).toHaveBeenCalledWith(['Quantum entanglement', "Bell's theorem"]);
    expect(onToken).toHaveBeenNthCalledWith(1, 'Entanglement ');
    expect(onToken).toHaveBeenNthCalledWith(2, 'links particles.');
    expect(onDone).toHaveBeenCalledWith({ query_type: 'vector_search', execution_time_ms: 842 });
    expect(onError).not.toHaveBeenCalled();

    expect(es.closeCount).toBe(1);
    expect(es.readyState).toBe(FakeEventSource.CLOSED);

    // Closing again after a terminal `done` is a no-op (idempotent).
    controller.close();
    expect(es.closeCount).toBe(1);
  });
});

describe('streamChat — in-stream error', () => {
  it('maps an `error` event with "TimeoutError" to onError TIMEOUT (status null) and closes', () => {
    const onError = vi.fn();
    const onDone = vi.fn();

    const api = streamClient();
    api.streamChat({ question: 'x' }, { onError, onDone });
    const es = lastFakeEventSource();

    es.emit('sources', JSON.stringify(['x']));
    es.emit('error', 'TimeoutError');

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as ApiClientError;
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe('TIMEOUT');
    expect(err.status).toBeNull();
    expect(es.closeCount).toBe(1);
  });

  it('maps an `error` event with "AgentError" to onError AGENT_ERROR', () => {
    const onError = vi.fn();

    const api = streamClient();
    api.streamChat({ question: 'x' }, { onError });
    const es = lastFakeEventSource();

    es.emit('token', 'partial');
    es.emit('error', 'AgentError');

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as ApiClientError;
    expect(err.code).toBe('AGENT_ERROR');
    expect(err.status).toBeNull();
  });
});

describe('streamChat — pre-stream failure', () => {
  it('maps an onerror before any named event to NETWORK_ERROR (status null) and closes once', () => {
    const onError = vi.fn();
    const onToken = vi.fn();

    const api = streamClient();
    api.streamChat({ question: 'x' }, { onError, onToken });
    const es = lastFakeEventSource();

    es.fail(); // transport error: fires onerror AND any 'error' listeners, no data

    expect(onToken).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1); // de-duped despite both error channels
    const err = onError.mock.calls[0][0] as ApiClientError;
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.status).toBeNull();
    expect(es.closeCount).toBe(1);
  });
});

describe('streamChat — controller + hardening', () => {
  it('controller.close() is idempotent — the EventSource is closed exactly once', () => {
    const api = streamClient();
    const controller = api.streamChat({ question: 'x' }, {});
    const es = lastFakeEventSource();

    controller.close();
    controller.close();
    controller.close();

    expect(es.closeCount).toBe(1);
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('reports a malformed `sources` payload as an ApiClientError instead of throwing', () => {
    const onSources = vi.fn();
    const onError = vi.fn();

    const api = streamClient();
    expect(() => {
      api.streamChat({ question: 'x' }, { onSources, onError });
      lastFakeEventSource().emit('sources', '{ this is not json');
    }).not.toThrow();

    expect(onSources).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(ApiClientError);
    expect(lastFakeEventSource().closeCount).toBe(1);
  });
});
