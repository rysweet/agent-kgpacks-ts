# @kgpacks/ingestion

The **write side** of the kgpacks platform (Phase 2): an end-to-end builder that
turns seed URLs into a LadybugDB knowledge pack that the existing
[`@kgpacks/query`](../query) read pipeline consumes unchanged.

```text
seeds ─▶ fetch (SSRF-safe) ─▶ clean / sectionize ─▶ extract (LLM) ─▶ chunk
      ─▶ embed (BGE, document mode) ─▶ load (LadybugDB) ─▶ expand (bounded BFS)
```

It is a strict-ESM TypeScript package built on the merged `@kgpacks/db`,
`@kgpacks/embeddings`, and `@kgpacks/agent`, with **zero third-party runtime
dependencies** (Node built-ins only). It ports the reference Python builder
(`bootstrap/src/{sources,extraction,expansion,database}`,
`bootstrap/schema/ryugraph_schema.py`).

## Public API

```ts
import { buildPack } from '@kgpacks/ingestion';

const result = await buildPack({
  seeds: ['https://en.wikipedia.org/wiki/Photosynthesis'],
  maxDepth: 1,
  maxArticles: 25,
});
// result.dbPath, result.articles, result.sections, result.chunks,
// result.entities, result.relationships, result.links
```

### Immutable CVE updates

`@kgpacks/ingestion` exports the versioned CVE adapter and the public lifecycle
API: `updateKnowledgePack`, `validateKnowledgePack`, request/result types, and
typed failures. `@kgpacks/packs` supplies the schema-v2 manifest types and
structural validation used by that lifecycle. Incremental updates do not reuse
`buildPack` or mutate an existing base database. See the
[incremental update reference](../../docs/reference/incremental-update.md).

Every external dependency is an **injectable seam** with a real default, so the
whole pipeline runs offline in tests:

| Seam                      | Default                                        | Inject for tests                    |
| ------------------------- | ---------------------------------------------- | ----------------------------------- |
| `fetcher`                 | `createSafeFetcher()` (HTTPS-only, SSRF-gated) | a `(url) => Promise<string>` fake   |
| `embedder`                | `BgeEmbedder` (document mode)                  | a deterministic `{ generate }` fake |
| `extractor` / `transport` | LLM extractor over the Copilot SDK             | a fake `Extractor` or `Transport`   |
| `connection`              | a fresh `Database(dbPath)`                     | a pre-opened in-memory `Connection` |

## Modules

| Module                    | Responsibility                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetcher.ts`              | HTTPS-only, SSRF-safe fetch: validates the URL and every redirect hop against the private/loopback/reserved/link-local blocklist (IPv4 + IPv6). |
| `sources.ts`              | HTML → plain text, heading-delimited sections, same-domain link extraction, Wikipedia title canonicalization.                                   |
| `extraction.ts`           | LLM entity/relationship/key-fact extraction with robust JSON parsing, sanitization, and relation normalization.                                 |
| `chunking.ts`             | Pure overlapping-window chunking of section text.                                                                                               |
| `schema.ts` / `loader.ts` | LadybugDB schema + node/edge/embedding loading and cosine HNSW vector indexes.                                                                  |
| `expansion.ts`            | Bounded breadth-first link discovery (work queue with `maxDepth` / `maxArticles`).                                                              |
| `index.ts`                | `buildPack(config)` orchestration.                                                                                                              |
| `incremental-update.ts`   | Immutable CVE update, resume, complete schema-v2 validation, and no-replace publication.                                                        |
| `article-copy.ts`         | Internal reconstruction of new and unchanged CVE articles, with stable ordering, provenance checks, and embedding alignment.                    |
| `resume-database.ts`      | Internal, non-exported normalization of writable update staging during resume; it never receives the read-only base connection.                 |

## Read-side contract (binding)

A pack built here is read by `@kgpacks/query`, so the schema honours its
expectations exactly:

- **`Section`** is the retrieval unit: `id` (STRING PK), `content`, and
  `embedding FLOAT[768]`, indexed as **`embedding_idx`** (cosine HNSW).
- The graph reranker traverses **`(Section)-[:LINKS_TO]->(Section)`** keyed on
  `Section.id`. Article→article links are therefore materialized as
  lead-section → lead-section `LINKS_TO` edges (a deliberate divergence from the
  reference's Article→Article edge, required for read compatibility).
- `Chunk` carries its own `chunk_embedding_idx` (cosine) and never collides with
  the `Section` read path.
- Both indexes are built after live rows are finalized with
  `pu := 0.9999999999999999`, the largest IEEE-754 value below LadybugDB's
  exclusive upper bound of `1`, to request complete build sampling.

### Incremental-update internals

`article-copy.ts` and `resume-database.ts` are deliberately private package
modules. They are not re-exported from `@kgpacks/ingestion`.

Article copying validates base source hashes, extractor identity, adapter
reproduction, requested-title coverage, and embedding data before preserving
database section/chunk order. New payload conversion embeds section content
before chunk content and preserves those slices in the resulting load record.
Failures reject the update; base-copy failures include rebuild guidance and keep
the original error as their cause.

Resume normalization receives only the writable staging connection. It removes
the two generated vector indexes plus generated `ENTITY_RELATION`, `LINKS_TO`,
`UpdateApplication`, and `PackMetadata` state when present. It leaves every
other index and row untouched. Each operation is separately retryable, and every
database failure propagates. See the
[resume and publication contract](../../docs/reference/incremental-update.md#resume-and-publication).

## Security

- **Update trust boundary:** pack and delta hashes provide local integrity, not
  producer authentication. The operator must establish input authenticity and
  exclusively control writable update, resume, and output paths. Do not run
  elevated updates over attacker-controlled filesystem paths.
- **SSRF defense:** only `https:` URLs, no embedded credentials, DNS resolution
  with every resolved address checked against private/loopback/reserved/
  link-local ranges (including IPv4-mapped IPv6 and the `169.254.169.254`
  cloud-metadata endpoint). Redirects are followed manually and each hop is
  re-validated, defeating redirect-to-internal pivots.
- **Prompt-injection defense:** article text is delimited as untrusted DATA in the
  extraction prompt, and the LLM runs through `@kgpacks/agent`'s tool-less,
  model-pinned session. Model output is JSON-parsed with `safeParseJson`
  (no `eval`, prototype-pollution guarded) and shape-validated before any write.

## Tests

`pnpm --filter @kgpacks/ingestion test`. All HTTP and LLM calls are mocked via the
seams; only the loader round-trip touches the (statically bundled) LadybugDB
`vector` extension.
