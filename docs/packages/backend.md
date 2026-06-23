# `@kgpacks/backend`

The HTTP server of the agent-kgpacks TypeScript port — a
[Fastify](https://fastify.dev) application that exposes the knowledge-graph query
API over `/api/v1`. It is a strict-ESM, **Python-free** port of the Python
FastAPI backend ([`rysweet/agent-kgpacks/backend/`](https://github.com/rysweet/agent-kgpacks))
and preserves that service's **exact route contract and JSON response shapes**, so
the existing frontend is drop-in compatible.

This document is the full reference: configuration, the programmatic
`buildServer` API, the complete HTTP contract for every endpoint, the SSE
streaming protocol, the error model, rate limiting, the per-request connection
lifecycle, and the testing strategy. For a short overview and quick start, see the
[package README](../../packages/backend/README.md).

- **Bricks & studs.** The single public seam is `buildServer(options)`, which
  returns a configured `FastifyInstance`. All external dependencies — the database,
  the LLM agent, the embedder — are injected through `options`, so the server runs
  identically in production (real deps) and in tests (offline fakes).
- **Built on the retrieval stack.** [`@kgpacks/db`](./db.md) (LadybugDB),
  [`@kgpacks/query`](../../packages/query/README.md) (retrieval),
  [`@kgpacks/agent`](./agent.md) (synthesis), and
  [`@kgpacks/embeddings`](../../packages/embeddings/README.md) (BGE vectors).

## Contents

- [Concurrency model](#concurrency-model)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Programmatic API](#programmatic-api)
- [HTTP API reference](#http-api-reference)
  - [Conventions](#conventions)
  - [`POST /api/v1/chat`](#post-apiv1chat)
  - [`GET /api/v1/chat/stream`](#get-apiv1chatstream-sse)
  - [`GET /api/v1/search`](#get-apiv1search)
  - [`GET /api/v1/hybrid-search`](#get-apiv1hybrid-search)
  - [`GET /api/v1/graph`](#get-apiv1graph)
  - [`GET /api/v1/articles/:title`](#get-apiv1articlestitle)
  - [`GET /api/v1/autocomplete`](#get-apiv1autocomplete)
  - [`GET /api/v1/categories`](#get-apiv1categories)
  - [`GET /api/v1/stats`](#get-apiv1stats)
  - [`GET /health`](#get-health)
- [Server-Sent-Events protocol](#server-sent-events-protocol)
- [Error model](#error-model)
- [Rate limiting](#rate-limiting)
- [Connection lifecycle](#connection-lifecycle)
- [Security headers & CORS](#security-headers--cors)
- [Testing strategy](#testing-strategy)
- [See also](#see-also)

## Concurrency model

LadybugDB `Connection` objects are **not safe for concurrent in-flight queries**
(established by Spike A; see [docs/packages/db.md](./db.md#spike-a-vector-smoke-test)).
The backend therefore guarantees **exactly one in-flight query per connection** and
**never shares a connection between requests**:

- Each ordinary request opens a **fresh** `Connection` on entry and closes it in a
  `finally` / `onResponse` hook — even on error.
- The SSE route (`GET /api/v1/chat/stream`) opens a **long-lived** connection
  _inside_ the stream generator and closes it only after answer synthesis settles,
  because the connection must outlive the normal request/response cycle.

A single `Database` (the LadybugDB handle) is created once and held for the
lifetime of the process; connections are cheap and per-request.

## Installation

`@kgpacks/backend` is an internal workspace package. Consume it from another
`@kgpacks/*` package via a workspace dependency:

```jsonc
// packages/<consumer>/package.json
{
  "dependencies": {
    "@kgpacks/backend": "workspace:*",
  },
}
```

It depends on `fastify@^5`, `@fastify/cors@^10`, and `@fastify/rate-limit@^10`,
plus the workspace packages `@kgpacks/db`, `@kgpacks/query`, `@kgpacks/agent`, and
`@kgpacks/embeddings`. Build and test it like any package in the monorepo:

```bash
pnpm --filter @kgpacks/backend build      # tsc -b (composite project references)
pnpm --filter @kgpacks/backend test       # vitest run (offline)
pnpm --filter @kgpacks/backend typecheck
```

## Quick start

```ts
import { Database } from '@kgpacks/db';
import { CopilotAgent } from '@kgpacks/agent';
import { buildServer } from '@kgpacks/backend';

const database = new Database('pack.lbug');

const agent = new CopilotAgent(); // BYOK provider + pinned model from env
await agent.start();

const app = await buildServer({ database, agent });

try {
  const address = await app.listen({ host: '127.0.0.1', port: 8000 });
  app.log.info(`backend listening on ${address}`);
} finally {
  // on shutdown
  // await app.close();
  // await agent.stop();
  // database.close();
}
```

```bash
# Semantic search
curl 'http://127.0.0.1:8000/api/v1/search?query=quantum%20entanglement&limit=5'

# Blocking chat
curl -X POST http://127.0.0.1:8000/api/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"question":"What is quantum entanglement?","max_results":8}'

# Streaming chat (SSE)
curl -N 'http://127.0.0.1:8000/api/v1/chat/stream?question=What%20is%20entanglement%3F'
```

### Running the binary

The package ships a thin bin (`dist/index.js`) that reads configuration from the
environment, opens the database, and starts listening:

```bash
WIKIGR_DATABASE_PATH=./pack.lbug \
WIKIGR_HOST=127.0.0.1 \
WIKIGR_PORT=8000 \
node packages/backend/dist/index.js
```

## Configuration

All settings are read from environment variables with the **`WIKIGR_`** prefix
(matching the Python `Settings`). `loadConfig(env = process.env)` is a pure
function that returns a frozen `Settings` object; `buildServer` and the bin both
use it. Environment overrides are the primary configuration path for the TS port.

| Variable                    | Type           | Default                                                                                   | Description                                                                          |
| --------------------------- | -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `WIKIGR_DATABASE_PATH`      | path           | _(required for bin)_                                                                      | Path to the LadybugDB pack. Use `:memory:` for an ephemeral DB.                      |
| `WIKIGR_HOST`               | string         | `127.0.0.1`                                                                               | Bind address.                                                                        |
| `WIKIGR_PORT`               | number         | `8000`                                                                                    | Bind port.                                                                           |
| `WIKIGR_CORS_ORIGINS`       | CSV            | `http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000,http://127.0.0.1:5173` | Allowed CORS origins.                                                                |
| `WIKIGR_RATE_LIMIT_ENABLED` | bool           | `true`                                                                                    | Master switch for per-route rate limiting. Set `false` to disable entirely.          |
| `WIKIGR_TRUSTED_PROXIES`    | CSV of IP/CIDR | _(empty)_                                                                                 | Peers from which `X-Forwarded-For` is honored for client-IP rate-limit keying.       |
| `WIKIGR_STREAM_TIMEOUT_S`   | number         | `60`                                                                                      | Max seconds the SSE route waits for synthesis before emitting `error: TimeoutError`. |
| `WIKIGR_API_TITLE`          | string         | `WikiGR Visualization API`                                                                | Reported in `/health` / OpenAPI metadata.                                            |
| `WIKIGR_API_VERSION`        | string         | `1.0.0`                                                                                   | Reported `version`.                                                                  |

**Per-route rate limits** (requests per minute) and **cache TTLs** (seconds) carry
the Python defaults and are also configurable via env (`WIKIGR_RATE_LIMIT_CHAT`,
`WIKIGR_RATE_LIMIT_SEARCH`, `WIKIGR_RATE_LIMIT_GRAPH`, …):

| Endpoint                 | Default limit | `Cache-Control` `max-age` |
| ------------------------ | ------------- | ------------------------- |
| chat (blocking + stream) | 5/min         | —                         |
| search                   | 10/min        | 3600                      |
| hybrid-search            | 10/min        | 3600                      |
| graph                    | 20/min        | 3600                      |
| articles                 | 30/min        | 86400                     |
| autocomplete             | 60/min        | 3600                      |
| categories               | 30/min        | 3600                      |
| stats                    | 30/min        | 300                       |
| health                   | none          | `no-store`                |

## Programmatic API

### `buildServer(options): Promise<FastifyInstance>`

Builds and returns a fully wired (but not-yet-listening) Fastify instance: CORS,
security-headers hook, rate-limit plugin, the per-request DB decorator, all
`/api/v1` routes, `/health`, and the global error/not-found handlers are all
registered. Call `app.listen(...)` to start serving and `app.close()` to stop.

```ts
interface BuildServerOptions {
  /** A constructed Database, or a path/`:memory:` string the server opens itself. */
  database: Database | string;

  /** LLM agent for chat synthesis. When omitted/unavailable, chat returns 503. */
  agent?: CopilotAgent;

  /** Query embedder. Defaults to the BGE embedder auto-injected by createRetriever. */
  embedder?: Embedder;

  /** Override the global rate-limit toggle (else WIKIGR_RATE_LIMIT_ENABLED). */
  rateLimit?: boolean;

  /** Override settings (else loadConfig(process.env)). */
  config?: Partial<Settings>;

  /** Fastify logger option. Defaults to off in tests. */
  logger?: boolean | object;
}
```

| Option      | Required | Notes                                                                                                                                                                |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`  | yes      | A `Database` instance, or a path string the server opens. Connections are created per request from this handle.                                                      |
| `agent`     | no       | Injected `CopilotAgent`. If absent (or its transport is unavailable), the chat endpoints report `AGENT_UNAVAILABLE` / `503` — every other endpoint works without it. |
| `embedder`  | no       | Query embedder used by chat retrieval; defaults to the validated BGE embedder.                                                                                       |
| `rateLimit` | no       | Boolean override of the global rate-limit switch; useful for tests.                                                                                                  |
| `config`    | no       | Shallow-merged over `loadConfig()`.                                                                                                                                  |
| `logger`    | no       | Standard Fastify logger option.                                                                                                                                      |

`buildServer` performs no network or filesystem I/O beyond opening the database
handle (if a path was passed); it is safe to call repeatedly in tests, each call
yielding an isolated instance.

### `loadConfig(env?): Settings`

Pure function mapping `WIKIGR_*` environment variables to a typed `Settings`
object (see [Configuration](#configuration)). No file I/O is required.

## HTTP API reference

### Conventions

- **Base prefix:** `/api/v1` for all data endpoints; `/health` is unprefixed.
- **Content type:** request and response bodies are JSON
  (`application/json; charset=utf-8`), except the SSE stream
  (`text/event-stream`).
- **Validation:** query/path/body parameters are validated against JSON schemas.
  A validation failure returns **`400`** with the standard
  [error envelope](#error-model) (`MISSING_PARAMETER` for an absent required
  field, otherwise `INVALID_PARAMETER`) — never Fastify's default validation body.
- **Caching:** read endpoints set `Cache-Control: public, max-age=<ttl>` per the
  [configuration table](#configuration); `/health` is `no-store`.
- **`execution_time_ms`** is server-measured wall-clock time for the operation.
- **Numeric parity.** Whole-valued floats in the Python contract (e.g. the graph
  edge `weight` of `1.0`, or an integer-valued `similarity`) serialize as `1` in
  JavaScript JSON. Contract parity is defined by **numeric** equality, not
  byte-for-byte string match — `1.0` and `1` are equivalent.

In the field tables below, `*` marks a required parameter.

---

### `POST /api/v1/chat`

Ask a question and receive a synthesized answer in a single blocking response.

**Request body**

| Field         | Type    | Rules                          | Default          |
| ------------- | ------- | ------------------------------ | ---------------- |
| `question`\*  | string  | length 1–500                   | —                |
| `pack`        | string  | matches `^[a-z0-9][a-z0-9-]*$` | _(default pack)_ |
| `max_results` | integer | 1–50                           | `10`             |

**Response `200`** — `ChatResponse`

```jsonc
{
  "answer": "Quantum entanglement is a phenomenon where two particles …",
  "sources": ["Quantum entanglement", "Bell's theorem"],
  "query_type": "vector_search",
  "execution_time_ms": 842,
}
```

| Field               | Type     | Notes                                                                       |
| ------------------- | -------- | --------------------------------------------------------------------------- |
| `answer`            | string   | Synthesized natural-language answer.                                        |
| `sources`           | string[] | Cited article titles, de-duplicated, order-preserved.                       |
| `query_type`        | string   | Stable retrieval-mode label; `"vector_search"` in Phase 1 (see note below). |
| `execution_time_ms` | number   | Server-measured.                                                            |

> **`query_type` is a stable label.** In the Python service `query_type` is a
> _dynamic_, LLM-classified value (defaulting to `"unknown"`). This TypeScript port
> uses a different retrieval pipeline — vector retrieval via `@kgpacks/query` — and
> therefore emits a **stable** label (`"vector_search"`) instead of reproducing the
> classifier. This is contract-safe: the frontend renders `query_type` as opaque
> display text and does not branch on its value.

**Errors:** `400 INVALID_PARAMETER` / `MISSING_PARAMETER`;
`400 INVALID_PACK_NAME`; `404 PACK_NOT_FOUND`; `503 AGENT_UNAVAILABLE` when no
usable agent is configured; `500 AGENT_ERROR` on synthesis failure.

> **Phase 1 pack scope.** The `pack` parameter is accepted and validated — an
> invalid name returns `400 INVALID_PACK_NAME` and an unknown pack returns
> `404 PACK_NOT_FOUND` — but Phase 1 serves only the **default pack** (the injected
> database). Resolving and serving an alternate pack by name is a thin, documented
> extension point that is **not yet active**, so clients should not rely on
> multi-pack serving in this phase.

```bash
curl -X POST http://127.0.0.1:8000/api/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"question":"What is quantum entanglement?","max_results":8}'
```

---

### `GET /api/v1/chat/stream` (SSE)

The same operation as `POST /chat`, streamed as
[Server-Sent Events](#server-sent-events-protocol). Use this for token-by-token UI
updates and early display of sources.

**Query parameters**

| Field         | Type    | Rules        | Default |
| ------------- | ------- | ------------ | ------- |
| `question`\*  | string  | length 1–500 | —       |
| `max_results` | integer | 1–50         | `10`    |

**Response:** `200` with `Content-Type: text/event-stream`. The body is the event
sequence `sources → token → done` (or a single `error`). See
[Server-Sent-Events protocol](#server-sent-events-protocol) for exact framing.

> If no usable agent is configured, the server responds **`503`** with the JSON
> error envelope **before** opening the stream, so clients can distinguish
> "service unavailable" from "stream that errored mid-flight".

```bash
curl -N 'http://127.0.0.1:8000/api/v1/chat/stream?question=What%20is%20entanglement%3F&max_results=8'
```

---

### `GET /api/v1/search`

Semantic (vector) search. Treats `query` as a **seed article title**, reads its
lead-section embedding, and returns the nearest articles by cosine similarity.

**Query parameters**

| Field       | Type    | Rules        | Default |
| ----------- | ------- | ------------ | ------- |
| `query`\*   | string  | length ≤ 200 | —       |
| `category`  | string  | length ≤ 200 | —       |
| `limit`     | integer | 1–100        | `10`    |
| `threshold` | number  | 0–1          | `0`     |

**Response `200`** — `SearchResponse`

```jsonc
{
  "query": "Quantum entanglement",
  "results": [
    {
      "article": "Bell's theorem",
      "similarity": 0.91,
      "category": "Physics",
      "word_count": 4210,
      "summary": "Bell's theorem proves that no physical theory of local hidden …",
    },
  ],
  "total": 1,
  "execution_time_ms": 37,
}
```

| `SearchResult` field | Type           | Notes                                         |
| -------------------- | -------------- | --------------------------------------------- |
| `article`            | string         | Article title.                                |
| `similarity`         | number         | `1 - distance`, clamped to `[0, 1]`.          |
| `category`           | string \| null | Article category, or `null`.                  |
| `word_count`         | number         | —                                             |
| `summary`            | string         | First ~200 chars of the lead section + `"…"`. |

Results are best-per-article, filtered by `category`/`threshold`, sorted by
`similarity` descending, then sliced to `limit`.

**Errors:** `400` on invalid parameters; `404 NOT_FOUND` when the seed article
does not exist.

---

### `GET /api/v1/hybrid-search`

Hybrid search blending vector similarity with **graph proximity** (`LINKS_TO`)
from the seed article. Returns the same `SearchResponse` shape as `/search`; the
`summary` field is the model default (`""`) for hybrid results.

**Query parameters**

| Field      | Type    | Rules        | Default |
| ---------- | ------- | ------------ | ------- |
| `query`\*  | string  | length ≤ 200 | —       |
| `category` | string  | length ≤ 200 | —       |
| `max_hops` | integer | 1–3          | `2`     |
| `limit`    | integer | 1–100        | `10`    |

```bash
curl 'http://127.0.0.1:8000/api/v1/hybrid-search?query=Quantum%20entanglement&max_hops=2&limit=10'
```

**Errors:** `400` on invalid parameters; `404 NOT_FOUND` for an unknown seed.

---

### `GET /api/v1/graph`

Return the graph neighborhood around a seed article: nodes reachable within
`depth` `LINKS_TO` hops, plus the edges among them.

**Query parameters**

| Field       | Type    | Rules        | Default |
| ----------- | ------- | ------------ | ------- |
| `article`\* | string  | length ≤ 500 | —       |
| `depth`     | integer | 1–3          | `2`     |
| `limit`     | integer | 1–200        | `50`    |
| `category`  | string  | length ≤ 200 | —       |

**Response `200`** — `GraphResponse`

```jsonc
{
  "seed": "Quantum entanglement",
  "nodes": [
    {
      "id": "Quantum entanglement",
      "title": "Quantum entanglement",
      "category": "Physics",
      "word_count": 5120,
      "depth": 0,
      "links_count": 12,
      "summary": "Quantum entanglement is a physical phenomenon …",
    },
  ],
  "edges": [
    {
      "source": "Quantum entanglement",
      "target": "Bell's theorem",
      "type": "internal",
      "weight": 1.0,
    },
  ],
  "total_nodes": 1,
  "total_edges": 1,
  "execution_time_ms": 51,
}
```

| `Node` field   | Type           | Notes                                    |
| -------------- | -------------- | ---------------------------------------- |
| `id` / `title` | string         | The article title (both fields).         |
| `category`     | string \| null | —                                        |
| `word_count`   | number         | —                                        |
| `depth`        | number         | Hop distance from the seed (`0` = seed). |
| `links_count`  | number         | Outgoing `LINKS_TO` count.               |
| `summary`      | string         | Lead-section summary.                    |

| `Edge` field        | Type   | Notes           |
| ------------------- | ------ | --------------- |
| `source` / `target` | string | Article titles. |
| `type`              | string | `"internal"`.   |
| `weight`            | number | `1.0`.          |

Nodes are ordered by `depth` ascending then `title` ascending and de-duplicated.

**Errors:** `400` on invalid parameters (including `depth` out of `[1,3]`);
`404 NOT_FOUND` for an unknown seed.

---

### `GET /api/v1/articles/:title`

Full detail for one article. The `:title` path segment is URL-encoded.

**Response `200`** — `ArticleDetail`

```jsonc
{
  "title": "Quantum entanglement",
  "category": "Physics",
  "word_count": 5120,
  "sections": [
    {
      "title": "Introduction",
      "content": "Quantum entanglement is …",
      "word_count": 320,
      "level": 1,
    },
  ],
  "links": ["Bell's theorem", "EPR paradox"],
  "backlinks": ["Quantum mechanics"],
  "categories": ["Physics"],
  "wikipedia_url": "https://en.wikipedia.org/wiki/Quantum_entanglement",
  "last_updated": "2026-06-23T05:44:07.000Z",
}
```

| Field           | Type           | Notes                                                            |
| --------------- | -------------- | ---------------------------------------------------------------- |
| `title`         | string         | —                                                                |
| `category`      | string \| null | —                                                                |
| `word_count`    | number         | —                                                                |
| `sections`      | `Section[]`    | `{ title, content, word_count, level }`, ordered by section id.  |
| `links`         | string[]       | Outgoing internal links (≤ 500).                                 |
| `backlinks`     | string[]       | Articles linking to this one (≤ 500).                            |
| `categories`    | string[]       | `[category]`.                                                    |
| `wikipedia_url` | string         | `https://en.wikipedia.org/wiki/<encoded title with spaces → _>`. |
| `last_updated`  | string         | ISO-8601 (`…Z`).                                                 |

```bash
curl 'http://127.0.0.1:8000/api/v1/articles/Quantum%20entanglement'
```

**Errors:** `404 NOT_FOUND` when the article does not exist.

---

### `GET /api/v1/autocomplete`

Title suggestions: prefix matches (`STARTS WITH`, case-insensitive) first, then
`CONTAINS` matches to fill out the list.

**Query parameters**

| Field   | Type    | Rules        | Default |
| ------- | ------- | ------------ | ------- |
| `q`\*   | string  | length 2–200 | —       |
| `limit` | integer | 1–20         | `10`    |

**Response `200`**

```jsonc
{
  "query": "quant",
  "suggestions": [
    { "title": "Quantum entanglement", "category": "Physics", "match_type": "prefix" },
    { "title": "Loop quantum gravity", "category": "Physics", "match_type": "contains" },
  ],
  "total": 2,
}
```

**Errors:** `400 INVALID_PARAMETER` when `q` is shorter than 2 characters.

---

### `GET /api/v1/categories`

```jsonc
{
  "categories": [
    { "name": "Physics", "article_count": 128 },
    { "name": "Mathematics", "article_count": 94 },
  ],
  "total": 2,
}
```

Ordered by `article_count` descending, then `name` ascending.

---

### `GET /api/v1/stats`

Corpus statistics. The result is cached in-process for 60 seconds.

```jsonc
{
  "articles": {
    "total": 512,
    "by_category": { "Physics": 128 },
    "by_depth": { "0": 12, "1": 240 },
  },
  "sections": { "total": 4096, "avg_per_article": 8.0 },
  "links": { "total": 9300, "avg_per_article": 18.1 },
  "database": { "size_mb": 42.7, "last_updated": "2026-06-23T05:44:07.000Z" },
  "performance": null,
}
```

For an in-memory database (`:memory:`), `database.size_mb` is `0`.

---

### `GET /health`

Liveness and database-reachability probe. Unprefixed and never rate-limited.

```jsonc
{
  "status": "healthy",
  "version": "1.0.0",
  "database": "connected",
  "timestamp": "2026-06-23T05:44:07.000Z",
}
```

Returns **`200`** when healthy and **`503`** (`status: "unhealthy"`,
`database: "disconnected"`) when the database cannot be reached.

## Server-Sent-Events protocol

`GET /api/v1/chat/stream` returns a `text/event-stream`. Each frame is
`event: <name>\n` followed by one `data: <payload>\n` line and a terminating blank
line. Response headers include `Cache-Control: no-cache`, `Connection:
keep-alive`, and `X-Accel-Buffering: no` (to defeat proxy buffering). The server
writes frames directly to the raw socket so event boundaries are exact and flushed
per event.

**Successful sequence** — exactly three events, in order:

| #   | `event:`  | `data:` payload                                                                      |
| --- | --------- | ------------------------------------------------------------------------------------ |
| 1   | `sources` | JSON array of cited article titles, e.g. `["Quantum entanglement","Bell's theorem"]` |
| 2   | `token`   | The **full** answer text in a single event (not incremental)                         |
| 3   | `done`    | JSON `{ "query_type": "...", "execution_time_ms": 123 }`                             |

**Error path** — a single event instead of the sequence above:

| `event:` | `data:` payload                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `error`  | The error **class name** string, e.g. `"TimeoutError"` (synthesis exceeded `WIKIGR_STREAM_TIMEOUT_S`) or `"AgentError"` (synthesis failed) |

> Agent-unavailable is reported as a **`503` JSON envelope before the stream
> opens** — it is _not_ an `error` event.

**Wire example**

```text
event: sources
data: ["Quantum entanglement","Bell's theorem"]

event: token
data: Quantum entanglement is a phenomenon where two particles share a state …

event: done
data: {"query_type":"vector_search","execution_time_ms":842}

```

**Browser client**

```ts
const es = new EventSource(
  '/api/v1/chat/stream?question=' + encodeURIComponent('What is entanglement?'),
);

es.addEventListener('sources', (e) => {
  const titles: string[] = JSON.parse(e.data);
  renderSources(titles);
});
es.addEventListener('token', (e) => {
  renderAnswer(e.data); // full answer text
});
es.addEventListener('done', (e) => {
  const { execution_time_ms } = JSON.parse(e.data);
  es.close();
});
es.addEventListener('error', (e) => {
  // e.data is the error class name, e.g. "TimeoutError"
  es.close();
});
```

## Error model

**Every** failure — validation, not-found, rate-limit, agent, or unexpected —
returns the same envelope, so clients can handle errors uniformly:

```jsonc
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Article 'Nonexistent' not found",
    "details": null,
  },
  "timestamp": "2026-06-23T05:44:07.000Z",
}
```

`timestamp` is ISO-8601 with a trailing `Z`. The envelope is produced by a global
`setErrorHandler` and `setNotFoundHandler`, which normalize Fastify's default
validation/404 bodies into this shape.

| Code                | HTTP | When                                              |
| ------------------- | ---- | ------------------------------------------------- |
| `MISSING_PARAMETER` | 400  | A required parameter is absent.                   |
| `INVALID_PARAMETER` | 400  | A parameter fails its schema (range/length/type). |
| `INVALID_PACK_NAME` | 400  | `pack` does not match `^[a-z0-9][a-z0-9-]*$`.     |
| `NOT_FOUND`         | 404  | The requested article/seed does not exist.        |
| `PACK_NOT_FOUND`    | 404  | A named pack is unknown.                          |
| `RATE_LIMITED`      | 429  | Per-route rate limit exceeded.                    |
| `AGENT_UNAVAILABLE` | 503  | No usable LLM agent is configured.                |
| `AGENT_ERROR`       | 500  | Answer synthesis failed.                          |
| `INTERNAL_ERROR`    | 500  | Any other unexpected failure.                     |

## Rate limiting

Rate limiting is implemented with
[`@fastify/rate-limit`](https://github.com/fastify/fastify-rate-limit), registered
globally with `{ global: false }` and applied **per route** via each route's
`config.rateLimit = { max, timeWindow: '1 minute' }`. Limits mirror the Python
limiter (see the [configuration table](#configuration)).

- **Keying:** the client IP. `X-Forwarded-For` (leftmost address) is honored
  **only** when the direct peer is within `WIKIGR_TRUSTED_PROXIES`; otherwise the
  socket address is used. This prevents header spoofing of the rate-limit key.
- **Exceeded:** the server returns **`429`** with the standard error envelope
  (`code: "RATE_LIMITED"`, message `"Rate limit exceeded"`) via a custom
  `errorResponseBuilder`.
- **Disable:** set `WIKIGR_RATE_LIMIT_ENABLED=false` (or pass `rateLimit: false`
  to `buildServer`) to turn limiting off entirely — useful in tests and for
  trusted internal deployments.

```jsonc
// HTTP 429
{
  "error": { "code": "RATE_LIMITED", "message": "Rate limit exceeded", "details": null },
  "timestamp": "2026-06-23T05:44:07.000Z",
}
```

## Connection lifecycle

The server decorates the Fastify instance with a connection manager built from the
injected `Database`. Two access patterns enforce the
[concurrency model](#concurrency-model):

- **Per-request (`withConnection`)** — ordinary routes run inside a helper that
  opens one `Connection`, loads the `vector` (and best-effort `fts`) extension,
  runs the handler, and closes the connection in `finally` / an `onResponse` hook.
  This is the TS equivalent of the Python `get_db()` dependency.
- **Long-lived (SSE)** — the chat stream opens its connection _inside_ the stream
  generator and closes it only after synthesis settles (the equivalent of the
  Python `get_long_lived_connection()`), because the connection must outlive the
  request/response cycle.

The invariant — **one in-flight query per connection, never shared** — is covered
by a leak test in the suite.

## Security headers & CORS

`buildServer` registers [`@fastify/cors`](https://github.com/fastify/fastify-cors)
for the configured origins (`GET, POST, OPTIONS`; allowed headers `Content-Type,
Accept`) and an `onSend` hook that sets defensive security headers on every
response:

| Header                    | Value                |
| ------------------------- | -------------------- |
| `X-Content-Type-Options`  | `nosniff`            |
| `X-Frame-Options`         | `DENY`               |
| `Referrer-Policy`         | `no-referrer`        |
| `X-XSS-Protection`        | `0`                  |
| `Content-Security-Policy` | `default-src 'none'` |

## Testing strategy

All tests run **offline** with [Vitest](https://vitest.dev) against an in-memory
LadybugDB fixture and fake dependencies — no native model load, no Copilot CLI
subprocess, no credentials.

- **Fixture (`test/fixture.ts`).** An in-memory `Database(':memory:')` with the
  `vector` extension loaded; `Article`, `Section`, `HAS_SECTION`, and `LINKS_TO`
  tables; a handful of seeded articles with deterministic lead-section embeddings
  and links; and a `Section.embedding_idx` cosine vector index. It reuses the
  proven pattern from `packages/query/test` and `packages/db` Spike A.
- **Stubs (`test/stubs.ts`).** `FakeAgent.synthesizeAnswer` returns a fixed
  `{ answer, metadata: { citedIds }, usage }`; `FakeEmbedder.generateQuery`
  returns a fixed vector of the fixture's dimension; `FakeTransport` drives
  agent-availability tests.
- **Route suites** (`routes.*.test.ts`) drive the server through `app.inject()`
  and assert response shape + status for the happy path, `404` for unknown
  articles, and the `400` envelope for bad parameters.
- **SSE framing** (`sse-framing.test.ts`) asserts the raw stream contains
  `event: sources / token / done` in order with the correct `data` payloads, that
  the timeout path emits `event: error` / `data: TimeoutError`, and that an
  unavailable agent yields a pre-stream `503` JSON envelope.
- **Rate-limit** (`rate-limit.test.ts`) exceeds `/search` to assert the `429`
  envelope, verifies `WIKIGR_RATE_LIMIT_ENABLED=false` disables limiting, and
  checks trusted-proxy `X-Forwarded-For` keying.
- **Contract snapshots** (`contract-snapshots.test.ts`) freeze each endpoint's
  JSON shape (keys/types; volatile fields like `execution_time_ms` and
  `last_updated` normalized) so the frontend stays drop-in compatible.

## See also

- [`packages/backend/README.md`](../../packages/backend/README.md) — overview and quick start.
- [`docs/packages/db.md`](./db.md) — LadybugDB wrapper and the Spike-A concurrency note.
- [`docs/packages/agent.md`](./agent.md) — the Copilot-SDK answer-synthesis layer.
- [`packages/query/README.md`](../../packages/query/README.md) — the retrieval pipeline used by chat.
- [`packages/embeddings/README.md`](../../packages/embeddings/README.md) — BGE query embeddings.
- [`docs/PLAN.md`](../PLAN.md) — the port plan and parity methodology.
- [`docs/monorepo.md`](../monorepo.md) — workspace layout and conventions.
