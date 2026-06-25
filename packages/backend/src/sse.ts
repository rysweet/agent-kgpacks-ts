// @kgpacks/backend — Server-Sent-Events framing.
//
// The chat stream (`GET /api/v1/chat/stream`) emits one event per line group:
//   event: <name>\n
//   data: <payload>\n
//   \n                      (terminating blank line)
// Ported from the reference `sse_starlette` `EventSourceResponse` framing. The
// payload is written verbatim — JSON for `sources`/`done`, raw text for `token`,
// and the error class name for `error`. Multi-line payloads are split into
// multiple `data:` lines per the SSE spec, which terminates lines on CRLF, a lone
// CR, *or* LF — so all three must be treated as line breaks (matching
// `sse_starlette`), otherwise a bare `\r` in a token answer would corrupt the
// client's parse of the rest of that line.

import { Readable } from 'node:stream';

/** Formats a single SSE event frame. */
export function formatSseEvent(event: string, data: string): string {
  const dataLines = data
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join('\n');
  return `event: ${event}\n${dataLines}\n\n`;
}

/** A single SSE event to emit. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Builds a Node `Readable` that emits the formatted frames produced by `source`.
 * Returning a stream (rather than hijacking the socket) keeps the route testable
 * via Fastify's `inject()` while preserving exact event boundaries.
 */
export function sseStream(source: () => AsyncIterable<SseEvent>): Readable {
  async function* frames(): AsyncGenerator<string> {
    for await (const evt of source()) {
      yield formatSseEvent(evt.event, evt.data);
    }
  }
  return Readable.from(frames());
}
