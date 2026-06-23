// @kgpacks/agent — robust JSON extraction.
//
// LLMs routinely wrap JSON in Markdown code fences. `stripMarkdownFences` mirrors
// the reference agent's `_strip_markdown_fences`, and `safeParseJson` parses with JSON.parse
// ONLY (never eval/Function/vm), guards against prototype pollution, and fails
// CLOSED with AgentResponseFormatError carrying the (size-capped) raw input.

import { AgentResponseFormatError } from './errors.js';

/** Own-property names that indicate a prototype-pollution payload. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Strips a surrounding Markdown code fence (```/```json/```JSON …) from model
 * output and trims surrounding whitespace. Bare (unfenced) text is returned
 * trimmed and unchanged. Tolerates a missing closing fence.
 */
export function stripMarkdownFences(text: string): string {
  let s = text.trim();
  if (s.length === 0) return '';
  if (s.startsWith('```')) {
    // Drop the opening fence line: ``` + optional language tag, through newline.
    s = s.replace(/^```[^\n]*\n?/, '');
    // Drop a trailing closing fence, if present.
    s = s.replace(/\n?```[ \t]*$/, '');
    s = s.trim();
  }
  return s;
}

/** Recursively detects an injected `__proto__`/`constructor`/`prototype` own key. */
function hasForbiddenKeys(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasForbiddenKeys);
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (FORBIDDEN_KEYS.has(key)) return true;
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
      if (hasForbiddenKeys(nested)) return true;
    }
  }
  return false;
}

/**
 * Parses JSON, failing closed. Throws {@link AgentResponseFormatError} (with the
 * offending content attached) on unparseable input or a prototype-pollution
 * payload. Returns `unknown`; callers shape-check the result.
 */
export function safeParseJson(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AgentResponseFormatError(
      `Model output is not valid JSON: ${(err as Error).message}`,
      text,
    );
  }
  if (hasForbiddenKeys(parsed)) {
    throw new AgentResponseFormatError(
      'Model output contains forbidden keys (possible prototype pollution).',
      text,
    );
  }
  return parsed;
}
