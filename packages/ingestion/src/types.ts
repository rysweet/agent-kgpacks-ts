// @kgpacks/ingestion — public type contracts.
//
// The package's stability surface for the WRITE side of the platform: the
// document model produced by the source/extraction/chunking stages, the injectable
// seams (fetch, embed, extract) that let unit tests run fully offline, and the
// `buildPack(config)` configuration/result shapes.
//
// Read-side compatibility is the binding constraint: a pack built here is consumed
// by @kgpacks/query, which retrieves `Section` nodes by `embedding_idx` (cosine)
// and traverses `(Section)-[:LINKS_TO]->(Section)` keyed on `Section.id`. The
// types and the loader honour that contract exactly.

import type { Transport } from '@kgpacks/agent';
import type { Connection } from '@kgpacks/db';

/** A named entity extracted from article text (reference: `Entity`). */
export interface Entity {
  /** Surface name (e.g. `'Ada Lovelace'`). Non-empty. */
  name: string;
  /** Coarse type: `person | place | organization | concept | event` (defaults to `concept`). */
  type: string;
  /** Optional free-text description / note. */
  description?: string;
}

/** A directed relationship between two entities (reference: `Relationship`). */
export interface Relationship {
  /** Source entity name. */
  source: string;
  /** Target entity name. */
  target: string;
  /** Normalized relation verb (e.g. `'founded'`). */
  relation: string;
  /** Sentence/clause the relation was drawn from. */
  context?: string;
}

/** The structured knowledge an article yields (reference: `ExtractionResult`). */
export interface ExtractionResult {
  entities: Entity[];
  relationships: Relationship[];
  keyFacts: string[];
}

/** One heading-delimited section of an article. */
export interface Section {
  /** Stable id, `"<articleTitle>#<index>"` (becomes the `Section.id` primary key). */
  id: string;
  /** Section heading. */
  title: string;
  /** Plain-text body. */
  content: string;
  /** Heading depth (0 = lead / article intro). */
  level: number;

  // ── Structured retrieval keys (optional, CVE packs) ─────────────────────────
  // Populated by the CVE adapter and persisted to the additive `Section` columns
  // for the `lexical` retrieve mode. Absent for prose (e.g. Wikipedia) sections,
  // which persist empty strings.
  /** The CVE id this section describes (e.g. `CVE-2021-44228`). */
  cveId?: string;
  /** Affected product names, `'; '`-joined. */
  affectedProducts?: string;
  /** Package/import-path aliases (e.g. `code.gitea.io/gitea`), `'; '`-joined. */
  aliases?: string;
  /** CPE identifiers, `'; '`-joined. */
  cpes?: string;
  /** Package URLs (purls), `'; '`-joined. */
  purls?: string;
  /** Package ecosystems (e.g. `go`, `npm`), `'; '`-joined. */
  ecosystems?: string;
}

/** A fetched + cleaned source document, split into sections. */
export interface Article {
  /** Canonical title (primary key in the graph). */
  title: string;
  /** The URL it was fetched from. */
  url: string;
  /** Optional inferred category. */
  category?: string;
  /** Heading-delimited sections, in document order. */
  sections: Section[];
  /** Same-domain outbound links discovered in the page, absolute and deduped. */
  links: string[];
}

/** A fine-grained, overlapping text window cut from a section (reference: `Chunk`). */
export interface Chunk {
  /** Stable id, `"<articleTitle>#<sectionIndex>#<chunkIndex>"`. */
  id: string;
  /** The chunk text. */
  content: string;
  /** Owning article title. */
  articleTitle: string;
  /** Section index within the article. */
  sectionIndex: number;
  /** Chunk index within the section. */
  chunkIndex: number;
}

/**
 * A directed article→article link mapped onto the graph as a `Section`→`Section`
 * edge (lead section to lead section). Only materialized when both endpoint
 * articles are loaded.
 */
export interface ArticleLink {
  from: string;
  to: string;
  linkType: string;
}

/**
 * Document embedder seam. The real implementation is `@kgpacks/embeddings`'
 * `BgeEmbedder.generate` (document mode: no query prefix, 768-dim, L2-normalized);
 * unit tests inject a deterministic fake so no model is downloaded.
 */
export interface Embedder {
  /** Stable model/configuration identity required by resumable incremental builds. */
  readonly modelId?: string;
  generate(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Minimal structural view of a `fetch` Response this package relies on. Both the
 * platform `fetch` and the injected test double satisfy it.
 */
export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /**
   * Optional raw body stream (present on the platform `fetch` Response). When
   * available, {@link createSafeFetcher} reads it with a hard byte cap so a huge
   * or decompression-bomb response cannot exhaust memory; test doubles that omit
   * it fall back to {@link FetchResponse.text}.
   */
  body?: ReadableStream<Uint8Array> | null;
}

/** Per-request options forwarded to the underlying fetch implementation. */
export interface FetchInit {
  redirect?: 'manual' | 'follow' | 'error';
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** The low-level fetch implementation seam (defaults to the platform `fetch`). */
export type FetchImpl = (url: string, init?: FetchInit) => Promise<FetchResponse>;

/** One resolved address for a hostname (subset of `node:dns` `LookupAddress`). */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** DNS resolution seam (defaults to `node:dns/promises` `lookup` with `all: true`). */
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * The high-level, SSRF-safe content fetcher: given an absolute HTTPS URL it
 * returns the response body text, having validated the URL (and every redirect
 * hop) against the private/loopback/reserved address blocklist. `sources` depends
 * only on this seam, so its tests inject a trivial fake.
 */
export type Fetcher = (url: string) => Promise<string>;

/**
 * The extraction seam: turns an article into structured knowledge. The real
 * implementation drives the Copilot SDK via `@kgpacks/agent`'s `Transport`; unit
 * tests inject a fake (or a fake `Transport`) so no model is invoked.
 */
export interface Extractor {
  extract(article: Article): Promise<ExtractionResult>;
  /** Releases any held resources (e.g. an open transport session). Optional. */
  close?(): Promise<void>;
}

/** Tuning for the section→chunk window. */
export interface ChunkOptions {
  /** Target chunk size in characters (default 512). */
  size?: number;
  /** Overlap between consecutive chunks in characters (default 64). */
  overlap?: number;
}

/** Configuration for {@link buildPack}. Only `seeds` is required. */
export interface BuildPackConfig {
  /** Seed article URLs to start ingestion from (HTTPS). */
  seeds: string[];
  /** On-disk database path. Defaults to an ephemeral in-memory database. */
  dbPath?: string;
  /** Maximum link-expansion depth from the seeds (default 1). */
  maxDepth?: number;
  /** Hard cap on the number of articles ingested (default 50). */
  maxArticles?: number;
  /** Section→chunk windowing options. */
  chunk?: ChunkOptions;

  // ── Injectable seams (defaults wire the real implementations) ──────────────
  /** SSRF-safe content fetcher. Default: {@link createSafeFetcher}. */
  fetcher?: Fetcher;
  /** Document embedder. Default: a fresh `BgeEmbedder` (document mode). */
  embedder?: Embedder;
  /** Knowledge extractor. Default: an LLM extractor over the Copilot transport. */
  extractor?: Extractor;
  /** Transport for the default extractor when no `extractor` is supplied. */
  transport?: Transport;
  /**
   * A pre-opened connection to load into. When provided, the caller owns its
   * lifecycle (buildPack will not close it), enabling round-trip tests against an
   * in-memory database. When omitted, buildPack opens (and closes) its own
   * database at `dbPath`.
   */
  connection?: Connection;
}

/** An article dropped during the build because its extract/embed step failed. */
export interface SkippedArticle {
  /** Title of the article that could not be processed. */
  title: string;
  /** Human-readable reason (the thrown error's message). */
  reason: string;
}

/** The outcome of a {@link buildPack} run: the loaded data plus simple counts. */
export interface BuildPackResult {
  /** Database path the pack was written to (`':memory:'` when ephemeral). */
  dbPath: string;
  /** Articles successfully ingested. */
  articles: Article[];
  /** All sections loaded (across every article). */
  sections: Section[];
  /** All chunks loaded. */
  chunks: Chunk[];
  /** Distinct entities loaded. */
  entities: Entity[];
  /** Entity→entity relationships loaded. */
  relationships: Relationship[];
  /** Section→section graph links materialized. */
  links: ArticleLink[];
  /**
   * Articles that were fetched but failed to extract/embed and were skipped so
   * the rest of the build could complete. Empty on a fully clean run.
   */
  skipped: SkippedArticle[];
}
