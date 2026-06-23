// @kgpacks/ingestion — source fetching + cleaning.
//
// Ports bootstrap/src/sources (web / wikipedia_source modules): fetch a page through
// the SSRF-safe fetcher, strip non-content chrome (script/style/nav/footer/header),
// convert the remaining HTML to plain text split into heading-delimited Sections,
// decode entities, collapse whitespace, and extract same-domain outbound links for
// expansion. Wikipedia article titles are canonicalized from the `/wiki/<Title>`
// path so discovered `/wiki/...` links line up with ingested article titles.
//
// Pure string functions (`parseArticleHtml`, `htmlToText`, `extractLinks`, …) carry
// the logic and are unit-tested directly with canned HTML — no network.

import type { Article, Fetcher, Section } from './types.js';

const SKIP_BLOCKS = /<(script|style|nav|footer|header|noscript|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi;
const HEADING = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
const BLOCK_BREAK = /<\/?(p|div|br|li|tr|ul|ol|table|section|article|blockquote)\b[^>]*>/gi;
const ANY_TAG = /<[^>]+>/g;
const HEADING_MARK = '\u001e'; // record separator marks a heading line
const LEVEL_SEP = '\u001f'; // unit separator splits level from title text

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201c',
  rdquo: '\u201d',
};

/** Decodes the common named and numeric HTML entities (no external dependency). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Strips all tags, decodes entities, and collapses runs of whitespace. */
function cleanInline(html: string): string {
  return collapseWhitespace(decodeEntities(html.replace(ANY_TAG, ' ')));
}

/** Collapses any run of whitespace into single spaces and trims the result. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Extracts the `<title>` text, trimmed of a trailing `" | Site"`-style suffix. */
export function extractTitle(html: string, url: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match) {
    const raw = cleanInline(match[1]);
    const title = raw.split(/\s*[|–—]\s*/)[0].trim();
    if (title.length > 0) {
      return title;
    }
  }
  return articleTitleFromUrl(url);
}

/**
 * Canonical article title for a URL. Wikipedia `/wiki/<Title>` paths decode to
 * `Title` with underscores turned into spaces; other URLs fall back to the last
 * path segment, title-cased.
 */
export function articleTitleFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const wiki = /^\/wiki\/(.+)$/.exec(parsed.pathname);
  if (wiki && /(^|\.)wikipedia\.org$/i.test(parsed.hostname)) {
    return safeDecode(wiki[1]).replace(/_/g, ' ').trim();
  }
  const segment =
    parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? parsed.hostname;
  return safeDecode(segment).replace(/[-_]/g, ' ').trim();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Infers up to three category labels from the URL path segments. */
export function inferCategories(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (/(^|\.)wikipedia\.org$/i.test(parsed.hostname)) {
    return [];
  }
  const stop = new Set(['en', 'us', 'docs', 'index', 'learn', 'wiki']);
  const segments = parsed.pathname.split('/').filter((s) => s.length > 2);
  const out: string[] = [];
  for (const seg of segments.slice(0, 3)) {
    const clean = collapseWhitespace(seg.replace(/[-_]/g, ' '));
    if (clean.length > 0 && !stop.has(clean.toLowerCase())) {
      out.push(titleCase(clean));
    }
  }
  return out;
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Extracts absolute, same-domain outbound links from anchor tags, deduped in order. */
export function extractLinks(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    const href = match[1].trim();
    if (href === '' || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) {
      continue;
    }
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'https:' || resolved.hostname !== base.hostname) {
      continue;
    }
    resolved.hash = '';
    const normalized = resolved.toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

/**
 * Converts a page's HTML into heading-delimited sections. Content before the first
 * heading becomes the lead section (level 0). Sections with empty content are
 * dropped, but the lead is always kept (it may hold the article intro).
 */
export function htmlToSections(html: string, leadTitle: string): Section[] {
  const withoutChrome = html.replace(SKIP_BLOCKS, ' ');

  // Mark headings, then linearize remaining block boundaries to newlines.
  const marked = withoutChrome.replace(HEADING, (_m, level: string, inner: string) => {
    const heading = cleanInline(inner);
    return `\n${HEADING_MARK}${level}${LEVEL_SEP}${heading}\n`;
  });
  const linear = marked.replace(BLOCK_BREAK, '\n');

  const sections: Section[] = [];
  let current: { title: string; level: number; parts: string[] } = {
    title: leadTitle,
    level: 0,
    parts: [],
  };

  const flush = (isLead: boolean): void => {
    const content = collapseWhitespace(current.parts.join(' '));
    if (content.length > 0 || isLead) {
      sections.push({ id: '', title: current.title, content, level: current.level });
    }
  };

  for (const line of linear.split('\n')) {
    if (line.startsWith(HEADING_MARK)) {
      flush(sections.length === 0);
      const sep = line.indexOf(LEVEL_SEP);
      const level = Number.parseInt(line.slice(HEADING_MARK.length, sep), 10);
      const title = line.slice(sep + 1).trim();
      current = {
        title: title.length > 0 ? title : leadTitle,
        level: Number.isFinite(level) ? level : 1,
        parts: [],
      };
    } else {
      const text = cleanInline(line);
      if (text.length > 0) {
        current.parts.push(text);
      }
    }
  }
  flush(sections.length === 0);

  return sections
    .filter((s, i) => i === 0 || s.content.length > 0)
    .map((s) => ({ ...s, content: collapseWhitespace(s.content) }));
}

/** Whole-document plain text (all sections joined) — handy for extraction input. */
export function htmlToText(html: string): string {
  return htmlToSections(html, 'Introduction')
    .map((s) => (s.level === 0 ? s.content : `${s.title}\n${s.content}`))
    .join('\n\n')
    .trim();
}

/**
 * Parses fetched HTML into an {@link Article}. Pure — no network. `title` overrides
 * the canonical title derived from `<title>`/URL when the caller already knows it.
 */
export function parseArticleHtml(html: string, url: string, title?: string): Article {
  const canonical = title ?? articleTitleFromUrl(url);
  const resolvedTitle =
    /(^|\.)wikipedia\.org$/i.test(safeHostname(url)) || title !== undefined
      ? canonical
      : extractTitle(html, url);

  const sections = htmlToSections(html, resolvedTitle).map((section, index) => ({
    ...section,
    id: `${resolvedTitle}#${index}`,
  }));
  const categories = inferCategories(url);

  return {
    title: resolvedTitle,
    url,
    category: categories[0],
    sections,
    // Extract links from content only — chrome (nav/footer/header) is not followed.
    links: extractLinks(html.replace(SKIP_BLOCKS, ' '), url),
  };
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Fetches a URL through the SSRF-safe fetcher and parses it into an {@link Article}. */
export async function fetchArticle(url: string, fetcher: Fetcher): Promise<Article> {
  const html = await fetcher(url);
  return parseArticleHtml(html, url);
}
