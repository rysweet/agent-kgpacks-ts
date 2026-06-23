// packages/agent/test/json.test.ts
//
// Offline unit tests for the JSON-extraction helpers in src/json.ts:
//   - stripMarkdownFences  — mirrors the Python `_strip_markdown_fences`
//   - safeParseJson        — JSON.parse-only, prototype-pollution guarded,
//                            fails CLOSED with AgentResponseFormatError
//
// These define the contract for robust extraction of the JSON the LLM returns
// (often wrapped in ```json … ``` fences). They run fully offline — no SDK, no
// network, no credentials.
//
// TDD (RED): src/json.ts and src/errors.ts do not exist yet, so these fail at
// import resolution today. They PASS once the helpers are implemented to spec.

import { describe, expect, it } from 'vitest';

import { AgentResponseFormatError } from '../src/errors.js';
import { safeParseJson, stripMarkdownFences } from '../src/json.js';

describe('stripMarkdownFences', () => {
  it('returns a bare JSON string unchanged', () => {
    expect(stripMarkdownFences('["a","b"]')).toBe('["a","b"]');
  });

  it('strips a ```json … ``` fenced block to its inner content', () => {
    expect(stripMarkdownFences('```json\n["a","b"]\n```')).toBe('["a","b"]');
  });

  it('strips a bare ``` … ``` fenced block to its inner content', () => {
    expect(stripMarkdownFences('```\n["a"]\n```')).toBe('["a"]');
  });

  it('strips a fence regardless of the language tag casing', () => {
    expect(stripMarkdownFences('```JSON\n["a"]\n```')).toBe('["a"]');
  });

  it('trims surrounding whitespace/newlines around a fenced block', () => {
    expect(stripMarkdownFences('\n\n```json\n["a"]\n```\n\n')).toBe('["a"]');
  });

  it('trims surrounding whitespace on unfenced text', () => {
    expect(stripMarkdownFences('   ["a"]   ')).toBe('["a"]');
  });

  it('strips an opening fence even when the closing fence is missing', () => {
    expect(stripMarkdownFences('```json\n["a"]')).toBe('["a"]');
  });

  it('returns an empty string for empty / whitespace-only input', () => {
    expect(stripMarkdownFences('')).toBe('');
    expect(stripMarkdownFences('   \n  ')).toBe('');
  });

  it('round-trips: stripped fenced JSON is parseable into the original array', () => {
    const stripped = stripMarkdownFences('```json\n["alpha","beta","gamma"]\n```');
    expect(JSON.parse(stripped)).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('safeParseJson', () => {
  it('parses a valid JSON array', () => {
    expect(safeParseJson('["a","b"]')).toEqual(['a', 'b']);
  });

  it('parses a valid JSON object', () => {
    expect(safeParseJson('{"answer":"hi","n":2}')).toEqual({ answer: 'hi', n: 2 });
  });

  it('composes with stripMarkdownFences for fenced model output', () => {
    const parsed = safeParseJson(stripMarkdownFences('```json\n["x","y"]\n```'));
    expect(parsed).toEqual(['x', 'y']);
  });

  it('throws AgentResponseFormatError on unparseable input', () => {
    expect(() => safeParseJson('not json at all')).toThrow(AgentResponseFormatError);
  });

  it('attaches the offending raw content to the thrown error', () => {
    try {
      safeParseJson('definitely-not-json');
      expect.unreachable('safeParseJson should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentResponseFormatError);
      expect((err as AgentResponseFormatError).rawContent).toContain('definitely-not-json');
    }
  });

  it('rejects objects carrying a top-level __proto__ key (prototype pollution)', () => {
    expect(() => safeParseJson('{"__proto__":{"polluted":true}}')).toThrow(
      AgentResponseFormatError,
    );
  });

  it('rejects objects carrying a top-level constructor key (prototype pollution)', () => {
    expect(() => safeParseJson('{"constructor":{"x":1}}')).toThrow(AgentResponseFormatError);
  });

  it('does NOT use eval — a function-expression payload is rejected, not executed', () => {
    expect(() => safeParseJson('(() => 1)()')).toThrow(AgentResponseFormatError);
  });
});
