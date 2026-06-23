// Pure section → chunk windowing.

import { describe, expect, it } from 'vitest';

import { chunkArticle, windowText } from '../src/chunking.js';
import { makeArticle } from './helpers.js';

describe('windowText', () => {
  it('returns a single window when text fits', () => {
    expect(windowText('short', 100, 10)).toEqual(['short']);
  });

  it('returns [] for blank text', () => {
    expect(windowText('   ', 100, 10)).toEqual([]);
  });

  it('produces overlapping windows that cover the whole text', () => {
    const text = 'abcdefghij'; // length 10
    const windows = windowText(text, 4, 1); // step = 3
    expect(windows).toEqual(['abcd', 'defg', 'ghij']);
    // Every character index is covered by some window.
    expect(windows.join('')).toContain('abcd');
    expect(windows[windows.length - 1].endsWith('j')).toBe(true);
  });

  it('always makes forward progress even with overlap >= size', () => {
    const windows = windowText('abcdef', 3, 99);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.length).toBeLessThanOrEqual(6);
  });
});

describe('chunkArticle', () => {
  it('chunks every section with stable, ordered ids', () => {
    const article = makeArticle('Topic', ['abcdefghij', 'abc']);
    const chunks = chunkArticle(article, { size: 4, overlap: 1 });

    const topicChunks = chunks.filter((c) => c.sectionIndex === 0);
    expect(topicChunks.map((c) => c.id)).toEqual(['Topic#0#0', 'Topic#0#1', 'Topic#0#2']);
    expect(topicChunks[0].articleTitle).toBe('Topic');

    const second = chunks.filter((c) => c.sectionIndex === 1);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe('Topic#1#0');
    expect(second[0].content).toBe('abc');
  });

  it('skips empty sections', () => {
    const article = makeArticle('T', ['', 'has content']);
    const chunks = chunkArticle(article);
    expect(chunks.every((c) => c.content.length > 0)).toBe(true);
    expect(chunks.some((c) => c.sectionIndex === 1)).toBe(true);
  });
});
