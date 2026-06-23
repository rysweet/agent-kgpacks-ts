// @kgpacks/ingestion — bounded link expansion (BFS work queue).
//
// Ports the core of bootstrap/src/expansion: starting from seed URLs, discover and
// fetch linked articles breadth-first, bounded by `maxDepth` (hops from a seed) and
// `maxArticles` (hard cap on total fetched). Articles are deduped by canonical
// title so the same article reached via different link forms is fetched once. Fetch
// failures are skipped (fail-soft) so one bad link can't abort a build.
//
// The fetch step is injected, so expansion is exercised with an in-memory link
// graph and zero network in unit tests.

import { articleTitleFromUrl } from './sources.js';
import type { Article } from './types.js';

/** Bounds for {@link expandFromSeeds}. */
export interface ExpansionOptions {
  /** Maximum hops from a seed (0 = seeds only). Default 1. */
  maxDepth?: number;
  /** Hard cap on the total number of articles fetched. Default 50. */
  maxArticles?: number;
}

/** An article paired with the depth at which it was discovered. */
export interface ExpandedArticle {
  article: Article;
  depth: number;
}

const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_ARTICLES = 50;

interface QueueItem {
  url: string;
  depth: number;
}

/**
 * Breadth-first link expansion from `seeds`. `fetchArticle` turns a URL into an
 * {@link Article} (it should already be SSRF-safe); errors it throws cause that URL
 * to be skipped. Returns the fetched articles in BFS order.
 */
export async function expandFromSeeds(
  seeds: string[],
  fetchArticle: (url: string) => Promise<Article>,
  options: ExpansionOptions = {},
): Promise<ExpandedArticle[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArticles = options.maxArticles ?? DEFAULT_MAX_ARTICLES;

  const results: ExpandedArticle[] = [];
  if (maxArticles <= 0) {
    return results;
  }

  const queue: QueueItem[] = seeds.map((url) => ({ url, depth: 0 }));
  const enqueuedTitles = new Set<string>(seeds.map((url) => articleTitleFromUrl(url)));
  const fetchedTitles = new Set<string>();

  while (queue.length > 0 && results.length < maxArticles) {
    const { url, depth } = queue.shift() as QueueItem;

    let article: Article;
    try {
      article = await fetchArticle(url);
    } catch {
      continue; // fail-soft: skip unreachable / blocked / malformed sources
    }

    if (fetchedTitles.has(article.title)) {
      continue;
    }
    fetchedTitles.add(article.title);
    results.push({ article, depth });

    if (depth >= maxDepth) {
      continue;
    }
    for (const link of article.links) {
      const title = articleTitleFromUrl(link);
      if (enqueuedTitles.has(title) || fetchedTitles.has(title)) {
        continue;
      }
      enqueuedTitles.add(title);
      queue.push({ url: link, depth: depth + 1 });
    }
  }

  return results;
}
