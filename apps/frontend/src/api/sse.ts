// apps/frontend/src/api/sse.ts
//
// `streamChat` over the browser-native `EventSource`. Consumes the backend's
// `sources → token → done` SSE sequence, maps every failure to an
// `ApiClientError`, and ALWAYS closes the connection exactly once (on done, on
// error, or via `controller.close()`). See docs/packages/frontend.md#streamchat-sse.

import { ApiClientError } from './errors';
import type { StreamDone } from './types';

/** A minimal SSE event shape (covers both real `MessageEvent` and test fakes). */
export interface SseEventLike {
  readonly data?: string;
}

export type SseListener = (event: SseEventLike) => void;

/** The subset of `EventSource` the client depends on (injectable for tests). */
export interface EventSourceLike {
  readonly readyState: number;
  onerror: ((event: SseEventLike) => void) | null;
  addEventListener(type: string, listener: SseListener): void;
  removeEventListener(type: string, listener: SseListener): void;
  close(): void;
}

export interface StreamHandlers {
  /** event: sources — JSON array of cited article titles. */
  onSources?(titles: string[]): void;
  /** event: token — answer text. Treated additively (concatenate). */
  onToken?(text: string): void;
  /** event: done — final metadata; the stream is closed immediately after. */
  onDone?(done: StreamDone): void;
  /** Terminal error (in-stream error event, or pre-stream service failure). */
  onError?(err: ApiClientError): void;
}

export interface StreamController {
  /** Idempotently close the EventSource (e.g. on React unmount or cancel). */
  close(): void;
}

// Streaming hardening: bound the accumulated answer and the event count so a
// hostile or runaway stream can never exhaust memory.
const MAX_ANSWER_LENGTH = 5_000_000;
const MAX_EVENTS = 100_000;

/**
 * Opens an SSE stream at `url` via `factory` and wires the backend's named
 * events to `handlers`. Returns a controller whose `close()` is idempotent.
 */
export function openChatStream(
  factory: (url: string) => EventSourceLike,
  url: string,
  handlers: StreamHandlers,
): StreamController {
  const source = factory(url);
  let closed = false;
  let answerLength = 0;
  let eventCount = 0;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    source.onerror = null;
    source.close();
  };

  const fail = (err: ApiClientError): void => {
    if (closed) return;
    handlers.onError?.(err);
    finish();
  };

  const overflowed = (): boolean => {
    if (++eventCount > MAX_EVENTS) {
      fail(new ApiClientError('INTERNAL_ERROR', 'The stream produced too many events.'));
      return true;
    }
    return false;
  };

  const onSources: SseListener = (event) => {
    if (closed || overflowed()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data ?? '');
    } catch {
      fail(new ApiClientError('INTERNAL_ERROR', 'Received a malformed sources payload.'));
      return;
    }
    if (!Array.isArray(parsed)) {
      fail(new ApiClientError('INTERNAL_ERROR', 'Received a malformed sources payload.'));
      return;
    }
    handlers.onSources?.(parsed.filter((title): title is string => typeof title === 'string'));
  };

  const onToken: SseListener = (event) => {
    if (closed || overflowed()) return;
    const text = event.data ?? '';
    answerLength += text.length;
    if (answerLength > MAX_ANSWER_LENGTH) {
      fail(new ApiClientError('INTERNAL_ERROR', 'The streamed answer exceeded the maximum size.'));
      return;
    }
    handlers.onToken?.(text);
  };

  const onDone: SseListener = (event) => {
    if (closed || overflowed()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data ?? '');
    } catch {
      fail(new ApiClientError('INTERNAL_ERROR', 'Received a malformed done payload.'));
      return;
    }
    if (parsed && typeof parsed === 'object') {
      handlers.onDone?.(parsed as StreamDone);
    }
    finish();
  };

  const onErrorEvent: SseListener = (event) => {
    if (closed) return;
    const data = typeof event.data === 'string' ? event.data : '';
    if (data.length > 0) {
      // In-stream error: the backend sends the error CLASS NAME as the payload.
      if (data === 'TimeoutError') {
        fail(new ApiClientError('TIMEOUT', 'The request timed out. Please try again.'));
      } else {
        fail(new ApiClientError('AGENT_ERROR', 'The agent failed to produce an answer.'));
      }
    } else {
      // Pre-stream / transport failure: the browser exposes no status or body, so
      // a pre-stream 503 and a genuine transport drop both surface as NETWORK_ERROR.
      fail(new ApiClientError('NETWORK_ERROR', 'The connection to the server failed.'));
    }
  };

  source.addEventListener('sources', onSources);
  source.addEventListener('token', onToken);
  source.addEventListener('done', onDone);
  source.addEventListener('error', onErrorEvent);
  source.onerror = () => {
    if (closed) return;
    fail(new ApiClientError('NETWORK_ERROR', 'The connection to the server failed.'));
  };

  return { close: finish };
}
