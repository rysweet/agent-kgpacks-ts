// Shared test helpers for @kgpacks/ingestion. Not a suite (no *.test.ts).

import type { Transport, TransportResponse, TransportSession } from '@kgpacks/agent';

import { EMBEDDING_DIM } from '../src/schema.js';
import type {
  Article,
  Embedder,
  ExtractionResult,
  Extractor,
  FetchImpl,
  FetchResponse,
  LookupFn,
  ResolvedAddress,
} from '../src/types.js';

/** A 768-dim one-hot vector (with an optional secondary lobe) as a number[]. */
export function oneHot(index: number, secondary?: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[((index % EMBEDDING_DIM) + EMBEDDING_DIM) % EMBEDDING_DIM] = 1;
  if (secondary !== undefined) {
    v[((secondary % EMBEDDING_DIM) + EMBEDDING_DIM) % EMBEDDING_DIM] = 0.25;
  }
  return v;
}

function hashToIndex(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % EMBEDDING_DIM;
}

/**
 * Deterministic, offline document embedder. Maps each text to a stable 768-dim
 * vector (primary lobe at a hashed dimension). Distinct texts get distinct-ish
 * vectors, so the cosine HNSW index is valid and queries are repeatable.
 */
export function makeEmbedder(): Embedder {
  return {
    async generate(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => Float32Array.from(oneHot(hashToIndex(t), hashToIndex(t) + 1)));
    },
  };
}

/** An extractor that returns a fixed result for every article. */
export function makeExtractor(result: ExtractionResult): Extractor {
  return {
    async extract(): Promise<ExtractionResult> {
      return result;
    },
  };
}

/** A fetcher returning canned HTML keyed by exact URL; unknown URLs reject. */
export function makeFetcher(pages: Record<string, string>): (url: string) => Promise<string> {
  return async (url: string): Promise<string> => {
    const html = pages[url];
    if (html === undefined) {
      throw new Error(`no canned page for ${url}`);
    }
    return html;
  };
}

/** Builds a {@link FetchResponse} double. */
export function makeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): FetchResponse {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string): string | null => lower.get(name.toLowerCase()) ?? null },
    text: async (): Promise<string> => body,
  };
}

/**
 * Builds injectable `fetchImpl` + `lookup` seams for fetcher tests.
 * - `resolves`: hostname → addresses. Unlisted hosts resolve to a public IP.
 * - `responses`: URL → response. Unlisted URLs return 200 'ok'.
 */
export function fakeNet(config: {
  resolves?: Record<string, ResolvedAddress[]>;
  responses?: Record<string, FetchResponse>;
}): { fetchImpl: FetchImpl; lookup: LookupFn; calls: string[] } {
  const calls: string[] = [];
  const lookup: LookupFn = async (hostname) => {
    return config.resolves?.[hostname] ?? [{ address: '93.184.216.34', family: 4 }];
  };
  const fetchImpl: FetchImpl = async (url) => {
    calls.push(url);
    return config.responses?.[url] ?? makeResponse(200, 'ok');
  };
  return { fetchImpl, lookup, calls };
}

/** A fake transport that returns scripted content from `session.send`. */
export function makeTransport(content: string): {
  transport: Transport;
  sends: string[];
  closed: () => boolean;
} {
  const sends: string[] = [];
  let isClosed = false;
  const session: TransportSession = {
    async send(prompt: string): Promise<TransportResponse> {
      sends.push(prompt);
      return {
        content,
        usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      };
    },
    async close(): Promise<void> {
      isClosed = true;
    },
  };
  const transport: Transport = {
    async open(): Promise<TransportSession> {
      return session;
    },
    async shutdown(): Promise<void> {},
  };
  return { transport, sends, closed: () => isClosed };
}

/** Minimal Wikipedia-ish HTML page for source/expansion tests. */
export function wikiHtml(title: string, lead: string, links: string[] = []): string {
  const anchors = links.map((href) => `<a href="${href}">link</a>`).join('');
  return [
    `<html><head><title>${title} - Wikipedia</title></head><body>`,
    `<p>${lead}</p>`,
    `<h2>History</h2><p>Some historical background about ${title}.</p>`,
    `<nav><a href="/wiki/Should_Be_Skipped_Nav">nav</a></nav>`,
    `<p>${anchors}</p>`,
    `</body></html>`,
  ].join('');
}

/** Builds a minimal Article fixture. */
export function makeArticle(
  title: string,
  sectionContents: string[],
  links: string[] = [],
): Article {
  return {
    title,
    url: `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}`,
    sections: sectionContents.map((content, i) => ({
      id: `${title}#${i}`,
      title: i === 0 ? title : `Section ${i}`,
      content,
      level: i === 0 ? 0 : 2,
    })),
    links,
  };
}
