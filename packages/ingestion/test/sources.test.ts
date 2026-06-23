// HTML cleaning, sectionizing, link extraction, and title canonicalization.

import { describe, expect, it } from 'vitest';

import {
  articleTitleFromUrl,
  collapseWhitespace,
  decodeEntities,
  extractLinks,
  extractTitle,
  fetchArticle,
  htmlToSections,
  htmlToText,
  inferCategories,
  parseArticleHtml,
} from '../src/sources.js';
import { makeFetcher, wikiHtml } from './helpers.js';

const WIKI_URL = 'https://en.wikipedia.org/wiki/Photosynthesis';

describe('decodeEntities + collapseWhitespace', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;')).toBe('a & b <c> A B');
    // &nbsp; decodes to a normal space (U+0020) so later whitespace-collapsing applies.
    const decoded = decodeEntities('x&nbsp;y');
    expect(decoded).toHaveLength(3);
    expect(decoded.charCodeAt(1)).toBe(0x20);
  });
  it('collapses whitespace runs', () => {
    expect(collapseWhitespace('  a\n\n  b\t c ')).toBe('a b c');
  });
});

describe('htmlToSections', () => {
  it('splits on headings with a lead section first', () => {
    const html =
      '<p>Intro paragraph.</p><h2>Background</h2><p>Background text.</p>' +
      '<h2>Uses</h2><p>Uses text.</p>';
    const sections = htmlToSections(html, 'Topic');
    expect(sections.map((s) => s.title)).toEqual(['Topic', 'Background', 'Uses']);
    expect(sections[0].level).toBe(0);
    expect(sections[0].content).toContain('Intro paragraph');
    expect(sections[1].content).toBe('Background text.');
    expect(sections[2].content).toBe('Uses text.');
  });

  it('drops script/style/nav/footer chrome from content', () => {
    const html =
      '<style>.x{}</style><script>evil()</script><p>Real body.</p>' +
      '<nav><p>navigation junk</p></nav><footer>foot</footer>';
    const text = htmlToText(html);
    expect(text).toContain('Real body.');
    expect(text).not.toContain('evil');
    expect(text).not.toContain('navigation junk');
    expect(text).not.toContain('foot');
  });
});

describe('extractLinks', () => {
  it('keeps absolute same-domain https links, deduped, dropping junk schemes', () => {
    const html = [
      '<a href="/wiki/Plant">a</a>',
      '<a href="https://en.wikipedia.org/wiki/Sunlight">b</a>',
      '<a href="https://en.wikipedia.org/wiki/Plant">dup</a>',
      '<a href="https://other.com/x">ext</a>',
      '<a href="#cite">anchor</a>',
      '<a href="mailto:a@b.com">mail</a>',
    ].join('');
    const links = extractLinks(html, WIKI_URL);
    expect(links).toEqual([
      'https://en.wikipedia.org/wiki/Plant',
      'https://en.wikipedia.org/wiki/Sunlight',
    ]);
  });
});

describe('articleTitleFromUrl', () => {
  it('canonicalizes Wikipedia /wiki/ paths (underscores → spaces, decoded)', () => {
    expect(articleTitleFromUrl('https://en.wikipedia.org/wiki/French_Revolution')).toBe(
      'French Revolution',
    );
    expect(articleTitleFromUrl('https://en.wikipedia.org/wiki/Caf%C3%A9')).toBe('Café');
  });
  it('falls back to the last path segment for generic URLs', () => {
    expect(articleTitleFromUrl('https://learn.example.com/azure/kubernetes-service/')).toBe(
      'kubernetes service',
    );
  });
});

describe('extractTitle + inferCategories (generic web)', () => {
  it('strips a trailing site suffix from <title>', () => {
    const html = '<title>Deploy AKS | Microsoft Learn</title>';
    expect(extractTitle(html, 'https://learn.example.com/azure/aks')).toBe('Deploy AKS');
  });
  it('infers categories from path segments', () => {
    expect(inferCategories('https://learn.example.com/azure/kubernetes/deploy')).toEqual([
      'Azure',
      'Kubernetes',
      'Deploy',
    ]);
  });
});

describe('parseArticleHtml + fetchArticle', () => {
  it('parses a Wikipedia page into a canonical-titled, sectioned Article', () => {
    const html = wikiHtml('Photosynthesis', 'Photosynthesis converts light to energy.', [
      '/wiki/Plant',
      'https://en.wikipedia.org/wiki/Sunlight',
      'https://external.example.com/x',
    ]);
    const article = parseArticleHtml(html, WIKI_URL);

    expect(article.title).toBe('Photosynthesis');
    expect(article.url).toBe(WIKI_URL);
    expect(article.sections.length).toBeGreaterThanOrEqual(2);
    expect(article.sections[0].id).toBe('Photosynthesis#0');
    expect(article.sections[0].content).toContain('converts light to energy');
    // Same-domain content links only; nav link and external dropped.
    expect(article.links).toEqual([
      'https://en.wikipedia.org/wiki/Plant',
      'https://en.wikipedia.org/wiki/Sunlight',
    ]);
  });

  it('fetchArticle pipes the fetcher body through parseArticleHtml', async () => {
    const html = wikiHtml('Plant', 'A plant is a living organism.');
    const fetcher = makeFetcher({ [WIKI_URL]: html });
    const article = await fetchArticle(WIKI_URL, fetcher);
    // Title is canonicalized from the (Wikipedia) URL, not the page <title>.
    expect(article.title).toBe('Photosynthesis');
    expect(article.sections[0].content).toContain('living organism');
  });
});
