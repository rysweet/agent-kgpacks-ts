import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { chunkArticle } from '../src/chunking.js';
import { CVE_ADAPTER_VERSION, cveToGraph } from '../src/cve-adapter.js';
import type { LoadableArticle } from '../src/loader.js';
import type { Embedder } from '../src/types.js';

interface ArticleConnection {
  run(statement: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
}

interface ArticleCopyModule {
  toLoadable(payload: string, embedder: Embedder): Promise<LoadableArticle>;
  readBaseLoadables(
    connection: ArticleConnection,
    titles: string[],
  ): Promise<Map<string, LoadableArticle>>;
}

const sourceRecords = readFileSync(
  resolve(import.meta.dirname, '../../../test/fixtures/cve-update/base.ndjson'),
  'utf8',
)
  .trim()
  .split('\n');

async function loadSubject(): Promise<ArticleCopyModule> {
  try {
    return await vi.importActual<ArticleCopyModule>('../src/article-copy.js');
  } catch (error) {
    expect(error, 'article copying must be implemented by article-copy.ts').toBeUndefined();
    throw error;
  }
}

function graphFor(payload: string) {
  const graph = cveToGraph(JSON.parse(payload));
  if (!graph) throw new Error('fixture must produce a CVE graph');
  return graph;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('article-copy decomposition', () => {
  it('truncates CVE descriptions without splitting Unicode surrogate pairs', () => {
    const longDescription = `${'a'.repeat(1499)}😀tail`;
    const graph = cveToGraph({
      cveMetadata: { cveId: 'CVE-2026-10000', state: 'PUBLISHED' },
      containers: { cna: { descriptions: [{ lang: 'en', value: longDescription }] } },
    });
    expect(graph?.article.sections[0].content).toBe(`${'a'.repeat(1499)}😀...`);
    expect(Buffer.from(graph?.article.sections[0].content ?? '').toString('utf8')).toBe(
      graph?.article.sections[0].content,
    );

    const entityGraph = cveToGraph({
      cveMetadata: { cveId: 'CVE-2026-10001', state: 'PUBLISHED' },
      containers: {
        cna: { descriptions: [{ lang: 'en', value: `${'b'.repeat(199)}😀tail` }] },
      },
    });
    expect(entityGraph?.extraction.entities[0].description).toBe(`${'b'.repeat(199)}😀`);
  });

  it('embeds section content before chunk content and preserves both embedding slices', async () => {
    const { toLoadable } = await loadSubject();
    const payload = sourceRecords[0];
    const graph = graphFor(payload);
    const chunks = chunkArticle(graph.article, { size: 4000, overlap: 0 });
    const expectedTexts = [
      ...graph.article.sections.map((section) => section.content),
      ...chunks.map((chunk) => chunk.content),
    ];
    const embeddings = expectedTexts.map((_, index) => Float32Array.of(index + 1));
    const generate = vi.fn(async () => embeddings);

    const loadable = await toLoadable(payload, { modelId: 'test', generate });

    expect(generate).toHaveBeenCalledExactlyOnceWith(expectedTexts);
    expect(loadable.article).toEqual(graph.article);
    expect(loadable.chunks).toEqual(chunks);
    expect(loadable.sectionEmbeddings).toEqual(embeddings.slice(0, graph.article.sections.length));
    expect(loadable.chunkEmbeddings).toEqual(embeddings.slice(graph.article.sections.length));
    expect(loadable).toMatchObject({
      extraction: graph.extraction,
      sourcePayload: payload,
      sourcePayloadHash: sha256(payload),
      extractorVersion: CVE_ADAPTER_VERSION,
    });
  });

  it('copies articles in stable title order with database section and chunk embeddings aligned', async () => {
    const { readBaseLoadables } = await loadSubject();
    const fixtures = sourceRecords.map((payload, fixtureIndex) => {
      const graph = graphFor(payload);
      const chunks = chunkArticle(graph.article, { size: 4000, overlap: 0 });
      return { payload, graph, chunks, fixtureIndex };
    });
    const ordered = [...fixtures].sort((left, right) =>
      left.graph.article.title.localeCompare(right.graph.article.title),
    );
    const run = vi.fn(
      async (
        statement: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        expect(params).toEqual({
          titles: fixtures.map(({ graph }) => graph.article.title).reverse(),
        });
        if (statement.includes('(a:Article), (src:ArticleSource)')) {
          expect(statement).toContain('ORDER BY title');
          return ordered.map(({ payload, graph, fixtureIndex }) => ({
            title: graph.article.title,
            category: graph.article.category ?? '',
            depth: fixtureIndex,
            payload,
            payloadHash: sha256(payload),
            extractorVersion: CVE_ADAPTER_VERSION,
          }));
        }
        if (statement.includes('HAS_SECTION')) {
          expect(statement).toContain('ORDER BY article, idx');
          return ordered.flatMap(({ graph, fixtureIndex }) =>
            graph.article.sections.map((section, idx) => ({
              article: graph.article.title,
              idx,
              ...section,
              embedding: [fixtureIndex, idx],
              cveId: section.cveId ?? '',
              affectedProducts: section.affectedProducts ?? '',
              aliases: section.aliases ?? '',
              cpes: section.cpes ?? '',
              purls: section.purls ?? '',
              ecosystems: section.ecosystems ?? '',
            })),
          );
        }
        expect(statement).toContain('ORDER BY article, sectionIndex, chunkIndex');
        return ordered.flatMap(({ graph, chunks, fixtureIndex }) =>
          chunks.map((chunk) => ({
            article: graph.article.title,
            sectionIndex: chunk.sectionIndex,
            chunkIndex: chunk.chunkIndex,
            id: chunk.id,
            content: chunk.content,
            embedding: [fixtureIndex, chunk.chunkIndex],
          })),
        );
      },
    );
    const titles = fixtures.map(({ graph }) => graph.article.title).reverse();

    const copied = await readBaseLoadables({ run }, titles);

    expect([...copied.keys()]).toEqual(ordered.map(({ graph }) => graph.article.title));
    for (const { graph, chunks, fixtureIndex } of ordered) {
      expect(copied.get(graph.article.title)).toMatchObject({
        article: graph.article,
        chunks,
        sectionEmbeddings: graph.article.sections.map((_, idx) => [fixtureIndex, idx]),
        chunkEmbeddings: chunks.map((chunk) => [fixtureIndex, chunk.chunkIndex]),
        expansionDepth: fixtureIndex,
      });
    }
  });

  it('rejects incomplete or forged source provenance', async () => {
    const { readBaseLoadables } = await loadSubject();
    const payload = sourceRecords[0];
    const title = graphFor(payload).article.title;

    for (const articleRows of [
      [],
      [
        {
          title,
          category: '',
          depth: 0,
          payload,
          payloadHash: 'forged',
          extractorVersion: CVE_ADAPTER_VERSION,
        },
      ],
    ]) {
      const connection: ArticleConnection = {
        async run(statement) {
          return statement.includes('(a:Article), (src:ArticleSource)') ? articleRows : [];
        },
      };
      await expect(readBaseLoadables(connection, [title])).rejects.toThrow(/provenance/i);
    }
  });

  it('wraps database-copy failures with actionable context and preserves the cause', async () => {
    const { readBaseLoadables } = await loadSubject();
    const failure = new Error('section query failed');
    const connection: ArticleConnection = {
      async run(statement) {
        if (statement.includes('HAS_SECTION')) throw failure;
        return [];
      },
    };

    const rejected = readBaseLoadables(connection, ['CVE-2025-1000']);

    await expect(rejected).rejects.toThrow(
      /base pack is not provenance-capable and must be rebuilt from source: section query failed/,
    );
    await expect(rejected).rejects.toMatchObject({ cause: failure });
  });
});
