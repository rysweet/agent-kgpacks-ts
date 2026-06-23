// The ingestion (write-side) execution seams.
//
// `create` / `update` delegate the build to an injectable {@link BuildPackSeam};
// `research-sources` delegates URL discovery to a {@link DiscoverSourcesSeam}.
// Mirroring the `query` runner, this keeps the heavy `@kgpacks/ingestion` stack
// (SSRF-safe fetch, the BGE embedding/ONNX runtime, the LLM extractor) OUT of the
// always-loaded module graph: the production seams `import()` it lazily, only when
// an ingestion command actually runs. Only TYPES are imported eagerly here (erased
// at compile time), so merely constructing the program stays cheap.

import type { BuildPackConfig, BuildPackResult } from '@kgpacks/ingestion';

/**
 * Builds a knowledge pack from a {@link BuildPackConfig} and returns the loaded
 * data. The default seam wires `@kgpacks/ingestion`'s `buildPack`; tests inject a
 * double (and the integration test a wrapper supplying mocked fetch/embed/extract
 * seams + a caller-owned connection).
 */
export type BuildPackSeam = (config: BuildPackConfig) => Promise<BuildPackResult>;

/** Inputs handed to a {@link DiscoverSourcesSeam} for one `research-sources` run. */
export interface DiscoverSourcesInput {
  /** Seed article URLs to crawl out from (HTTPS). */
  seeds: string[];
  /** Maximum link-expansion depth from the seeds. */
  maxDepth: number;
  /** Hard cap on the total number of articles fetched during discovery. */
  maxArticles: number;
}

/**
 * Discovers same-domain source URLs reachable from `seeds`, EXCLUDING the seeds
 * themselves. The resolved list is the `discovered` field `research-sources`
 * prints. The default seam runs a fetch-only bounded BFS; tests inject a double.
 */
export type DiscoverSourcesSeam = (input: DiscoverSourcesInput) => Promise<string[]>;

/**
 * Builds the default production build seam.
 *
 * `@kgpacks/ingestion` (and the embedding/model runtime it pulls in) is imported
 * lazily on first call, so constructing the program — or running any non-ingestion
 * command — never loads the write-side stack.
 */
export function defaultBuildPack(): BuildPackSeam {
  return async (config: BuildPackConfig): Promise<BuildPackResult> => {
    const { buildPack } = await import('@kgpacks/ingestion');
    return buildPack(config);
  };
}

/**
 * Builds the default production discovery seam: a fetch-only bounded breadth-first
 * crawl via `expandFromSeeds` (no extract / embed / load). `expandFromSeeds` returns
 * the seed articles at depth `0` alongside their expansion; we keep only the
 * deeper hops so a seed URL never appears in its own `discovered` output.
 */
export function defaultDiscoverSources(): DiscoverSourcesSeam {
  return async ({ seeds, maxDepth, maxArticles }: DiscoverSourcesInput): Promise<string[]> => {
    const { createSafeFetcher, fetchArticle, expandFromSeeds } = await import('@kgpacks/ingestion');
    const fetcher = createSafeFetcher();
    const expanded = await expandFromSeeds(seeds, (url) => fetchArticle(url, fetcher), {
      maxDepth,
      maxArticles,
    });
    return expanded.filter((e) => e.depth > 0).map((e) => e.article.url);
  };
}
