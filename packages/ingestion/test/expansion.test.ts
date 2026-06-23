// Bounded BFS link expansion: depth/article caps, dedupe, fail-soft.

import { describe, expect, it } from 'vitest';

import { expandFromSeeds } from '../src/expansion.js';
import type { Article } from '../src/types.js';
import { makeArticle } from './helpers.js';

const url = (title: string): string => `https://en.wikipedia.org/wiki/${title}`;

// Link graph: A → {B, C}; B → {D, Broken}; C → {D}; D → {}.
const GRAPH: Record<string, Article> = {
  [url('A')]: makeArticle('A', ['A body'], [url('B'), url('C')]),
  [url('B')]: makeArticle('B', ['B body'], [url('D'), url('Broken')]),
  [url('C')]: makeArticle('C', ['C body'], [url('D')]),
  [url('D')]: makeArticle('D', ['D body'], []),
};

const fetchArticle = async (u: string): Promise<Article> => {
  const article = GRAPH[u];
  if (article === undefined) {
    throw new Error(`unreachable: ${u}`); // e.g. the 'Broken' link
  }
  return article;
};

describe('expandFromSeeds', () => {
  it('fetches only the seeds at depth 0', async () => {
    const out = await expandFromSeeds([url('A')], fetchArticle, { maxDepth: 0 });
    expect(out.map((e) => e.article.title)).toEqual(['A']);
  });

  it('expands one hop at maxDepth 1 (seeds + direct neighbours)', async () => {
    const out = await expandFromSeeds([url('A')], fetchArticle, { maxDepth: 1 });
    expect(out.map((e) => e.article.title).sort()).toEqual(['A', 'B', 'C']);
    expect(out.find((e) => e.article.title === 'A')?.depth).toBe(0);
    expect(out.find((e) => e.article.title === 'B')?.depth).toBe(1);
  });

  it('dedupes shared neighbours and skips unreachable links (fail-soft)', async () => {
    const out = await expandFromSeeds([url('A')], fetchArticle, { maxDepth: 2 });
    const titles = out.map((e) => e.article.title).sort();
    // D reached via both B and C but fetched once; 'Broken' is skipped.
    expect(titles).toEqual(['A', 'B', 'C', 'D']);
  });

  it('honours the maxArticles hard cap in BFS order', async () => {
    const out = await expandFromSeeds([url('A')], fetchArticle, {
      maxDepth: 5,
      maxArticles: 2,
    });
    expect(out.map((e) => e.article.title)).toEqual(['A', 'B']);
  });

  it('returns nothing when maxArticles is 0', async () => {
    const out = await expandFromSeeds([url('A')], fetchArticle, { maxArticles: 0 });
    expect(out).toEqual([]);
  });
});
