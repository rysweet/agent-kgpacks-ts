// LLM extraction: prompt, robust JSON parsing, sanitization, normalization.

import { describe, expect, it } from 'vitest';

import { ExtractionError } from '../src/errors.js';
import {
  buildExtractionPrompt,
  createLlmExtractor,
  normalizeRelation,
  parseExtractionResponse,
  sanitizeEntities,
  sanitizeKeyFacts,
  sanitizeRelationships,
} from '../src/extraction.js';
import { makeArticle, makeTransport } from './helpers.js';

describe('normalizeRelation', () => {
  it('lowercases, underscores, and maps synonyms to canonical forms', () => {
    expect(normalizeRelation('Co-Founded')).toBe('founded');
    expect(normalizeRelation('led to')).toBe('caused');
    expect(normalizeRelation('FOUNDED')).toBe('founded');
    expect(normalizeRelation('depends on')).toBe('requires');
  });
  it('keeps unknown relations as a normalized token', () => {
    expect(normalizeRelation('Married To')).toBe('married_to');
  });
});

describe('sanitizers', () => {
  it('drops invalid entities and defaults missing type to concept', () => {
    const entities = sanitizeEntities([
      { name: 'Ada Lovelace', type: 'person' },
      { name: '   ', type: 'person' }, // empty name dropped
      { name: 'X' }, // missing type → concept
      { type: 'person' }, // missing name dropped
      'nope', // non-object dropped
    ]);
    expect(entities).toEqual([
      { name: 'Ada Lovelace', type: 'person', description: undefined },
      { name: 'X', type: 'concept', description: undefined },
    ]);
  });

  it('drops relationships missing source/target/relation and normalizes the verb', () => {
    const rels = sanitizeRelationships([
      { source: 'A', target: 'B', relation: 'co-founded' },
      { source: 'A', relation: 'led' }, // missing target
      { source: '', target: 'B', relation: 'x' }, // empty source
    ]);
    expect(rels).toEqual([{ source: 'A', target: 'B', relation: 'founded', context: undefined }]);
  });

  it('keeps only non-empty string facts', () => {
    expect(sanitizeKeyFacts(['fact one', '  ', 42, 'fact two'])).toEqual(['fact one', 'fact two']);
    expect(sanitizeKeyFacts('not a list')).toEqual([]);
  });
});

describe('parseExtractionResponse', () => {
  it('parses a clean JSON object', () => {
    const result = parseExtractionResponse(
      JSON.stringify({
        entities: [{ name: 'Sun', type: 'concept' }],
        relationships: [{ source: 'Plant', target: 'Sun', relation: 'uses' }],
        key_facts: ['Plants need light'],
      }),
    );
    expect(result.entities).toHaveLength(1);
    expect(result.relationships[0].relation).toBe('uses');
    expect(result.keyFacts).toEqual(['Plants need light']);
  });

  it('strips a Markdown code fence before parsing', () => {
    const fenced =
      '```json\n{"entities":[{"name":"X","type":"concept"}],"relationships":[],"key_facts":[]}\n```';
    const result = parseExtractionResponse(fenced);
    expect(result.entities[0].name).toBe('X');
  });

  it('degrades malformed inner lists to empty without throwing', () => {
    const result = parseExtractionResponse('{"entities":"oops","relationships":null}');
    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.keyFacts).toEqual([]);
  });

  it('fails closed on non-JSON output', () => {
    expect(() => parseExtractionResponse('I am not JSON')).toThrow(ExtractionError);
  });

  it('fails closed when output is a JSON array, not an object', () => {
    expect(() => parseExtractionResponse('[1,2,3]')).toThrow(ExtractionError);
  });
});

describe('buildExtractionPrompt', () => {
  it('delimits untrusted data and requests a JSON object', () => {
    const article = makeArticle('Topic', ['Lead text here.', 'More detail.']);
    const prompt = buildExtractionPrompt(article);
    expect(prompt).toContain('untrusted DATA');
    expect(prompt).toContain('Article title: Topic');
    expect(prompt).toContain('Lead text here.');
    expect(prompt).toContain('"entities"');
  });

  it('truncates over-long article text', () => {
    const article = makeArticle('Big', ['x'.repeat(20_000)]);
    const prompt = buildExtractionPrompt(article, 100);
    expect(prompt).toContain('...[truncated]');
  });
});

describe('createLlmExtractor (fake transport)', () => {
  it('opens a session, sends the prompt, parses + sanitizes, and closes', async () => {
    const { transport, sends, closed } = makeTransport(
      JSON.stringify({
        entities: [{ name: 'Light', type: 'concept' }],
        relationships: [{ source: 'Plant', target: 'Light', relation: 'utilizes' }],
        key_facts: ['fact'],
      }),
    );
    const extractor = createLlmExtractor({ transport });
    const article = makeArticle('Photosynthesis', ['Plants use light.']);

    const result = await extractor.extract(article);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('Plants use light.');
    expect(result.entities[0].name).toBe('Light');
    expect(result.relationships[0].relation).toBe('uses'); // utilizes → uses

    await extractor.close?.();
    expect(closed()).toBe(true);
  });
});
