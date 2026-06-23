// @kgpacks/backend — article-detail / categories / stats service.
//
// Direct-Cypher port of the reference `services/article_service.ArticleService`:
//   - `getArticleDetails` — metadata, ordered sections, links, backlinks.
//   - `getCategories`     — category counts, busiest first.
//   - `getStats`          — corpus statistics, cached in-process for 60 s.

import { statSync } from 'node:fs';

import type { Connection, Row } from '@kgpacks/db';

import { ApiError, nowIso } from '../errors.js';
import type {
  ArticleDetail,
  ArticleSection,
  CategoryListResponse,
  StatsResponse,
} from '../types.js';
import { round1, toNullableText, toNumber, toText } from '../util.js';

const LINK_LIMIT = 500;
const STATS_TTL_MS = 60_000;

/** Encodes an article title for its Wikipedia URL (reference `quote(safe='/:@')`). */
function wikipediaUrl(title: string): string {
  const encoded = encodeURIComponent(title.replaceAll(' ', '_'))
    .replaceAll('%2F', '/')
    .replaceAll('%3A', ':')
    .replaceAll('%40', '@');
  return `https://en.wikipedia.org/wiki/${encoded}`;
}

/** Full detail for one article; throws `404` when it does not exist. */
export async function getArticleDetails(conn: Connection, title: string): Promise<ArticleDetail> {
  const meta = await conn.run<Row>(
    `MATCH (a:Article {title: $title})
     RETURN a.category AS category, a.word_count AS word_count`,
    { title },
  );
  if (meta.length === 0) {
    throw ApiError.notFound('Article not found');
  }
  const category = toNullableText(meta[0].category);
  const wordCount = toNumber(meta[0].word_count);

  const sectionRows = await conn.run<Row>(
    `MATCH (a:Article {title: $title})-[h:HAS_SECTION]->(s:Section)
     RETURN s.title AS title, s.content AS content, s.word_count AS word_count,
            s.level AS level, h.section_index AS idx
     ORDER BY idx ASC`,
    { title },
  );
  const sections: ArticleSection[] = sectionRows.map((row) => ({
    title: toText(row.title),
    content: toText(row.content),
    word_count: toNumber(row.word_count),
    level: toNumber(row.level),
  }));

  const linkRows = await conn.run<Row>(
    `MATCH (a:Article {title: $title})-[:LINKS_TO]->(target:Article)
     RETURN target.title AS title
     ORDER BY title ASC
     LIMIT ${LINK_LIMIT}`,
    { title },
  );
  const links = linkRows.map((row) => toText(row.title));

  const backlinkRows = await conn.run<Row>(
    `MATCH (source:Article)-[:LINKS_TO]->(a:Article {title: $title})
     RETURN source.title AS title
     ORDER BY title ASC
     LIMIT ${LINK_LIMIT}`,
    { title },
  );
  const backlinks = backlinkRows.map((row) => toText(row.title));

  return {
    title,
    category,
    word_count: wordCount,
    sections,
    links,
    backlinks,
    categories: category ? [category] : [],
    wikipedia_url: wikipediaUrl(title),
    last_updated: nowIso(),
  };
}

/** All categories with article counts, busiest first then alphabetical. */
export async function getCategories(conn: Connection): Promise<CategoryListResponse> {
  const rows = await conn.run<Row>(
    `MATCH (a:Article)
     WHERE a.category IS NOT NULL
     RETURN a.category AS category, count(*) AS count
     ORDER BY count DESC, category ASC`,
  );
  const categories = rows.map((row) => ({
    name: toText(row.category),
    article_count: toNumber(row.count),
  }));
  return { categories, total: categories.length };
}

/** Per-server cache for {@link getStats} (60 s TTL), avoiding repeated scans. */
export class StatsCache {
  #value: StatsResponse | null = null;
  #at = 0;

  get(now: number): StatsResponse | null {
    if (this.#value !== null && now - this.#at < STATS_TTL_MS) {
      return this.#value;
    }
    return null;
  }

  set(value: StatsResponse, now: number): void {
    this.#value = value;
    this.#at = now;
  }
}

function databaseSizeMb(databasePath: string): number {
  if (!databasePath || databasePath === ':memory:') return 0;
  try {
    const stat = statSync(databasePath);
    if (stat.isFile()) return round2(stat.size / (1024 * 1024));
    return 0;
  } catch {
    return 0;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Corpus statistics, served from {@link StatsCache} when fresh. */
export async function getStats(
  conn: Connection,
  databasePath: string,
  cache: StatsCache,
): Promise<StatsResponse> {
  const now = Date.now();
  const cached = cache.get(now);
  if (cached !== null) return cached;

  const totalRows = await conn.run<Row>('MATCH (a:Article) RETURN count(*) AS total');
  const totalArticles = toNumber(totalRows[0]?.total);

  const categoryRows = await conn.run<Row>(
    `MATCH (a:Article)
     WHERE a.category IS NOT NULL
     RETURN a.category AS category, count(*) AS count
     ORDER BY count DESC`,
  );
  const byCategory: Record<string, number> = {};
  for (const row of categoryRows) byCategory[toText(row.category)] = toNumber(row.count);

  const depthRows = await conn.run<Row>(
    `MATCH (a:Article)
     WHERE a.expansion_depth IS NOT NULL
     RETURN a.expansion_depth AS depth, count(*) AS count
     ORDER BY depth ASC`,
  );
  const byDepth: Record<string, number> = {};
  for (const row of depthRows) byDepth[String(toNumber(row.depth))] = toNumber(row.count);

  const sectionRows = await conn.run<Row>('MATCH (s:Section) RETURN count(*) AS total');
  const totalSections = toNumber(sectionRows[0]?.total);

  const linkRows = await conn.run<Row>('MATCH ()-[r:LINKS_TO]->() RETURN count(r) AS total');
  const totalLinks = toNumber(linkRows[0]?.total);

  const result: StatsResponse = {
    articles: { total: totalArticles, by_category: byCategory, by_depth: byDepth },
    sections: {
      total: totalSections,
      avg_per_article: totalArticles > 0 ? round1(totalSections / totalArticles) : 0,
    },
    links: {
      total: totalLinks,
      avg_per_article: totalArticles > 0 ? round1(totalLinks / totalArticles) : 0,
    },
    database: { size_mb: databaseSizeMb(databasePath), last_updated: nowIso() },
    performance: null,
  };

  cache.set(result, now);
  return result;
}
