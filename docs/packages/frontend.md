# `@kgpacks/frontend`

The web **frontend** of the agent-kgpacks TypeScript port — a
[Vite](https://vite.dev) + [React 18](https://react.dev) + **strict TypeScript**
single-page app that talks to [`@kgpacks/backend`](./backend.md)'s `/api/v1` API.
It provides a streaming **chat panel**, a **search box**, and a lightweight
**results / graph view**, reproducing the API-client contract of the original
Python repo's React SPA
([`rysweet/agent-kgpacks/frontend/`](https://github.com/rysweet/agent-kgpacks))
without copying its code.

Unlike every other workspace package, the frontend lives under **`apps/`** rather
than `packages/`. It is a deployable application (a static SPA bundle), not a
library other packages depend on, and keeping it under `apps/` also keeps it out
of the repo's structural governance suites, which only scan `packages/*` (see
[Workspace placement](#workspace-placement)).

This document is the full reference: workspace placement, configuration, the
typed API client (every method, request/response type, the SSE streaming
contract, and the error model), the UI components and hooks, the build and test
strategy, and the security model. For a short overview and quick start, see the
[package README](../../apps/frontend/README.md).

- **One public seam: the API client.** All network access goes through a single
  typed `ApiClient` (`src/api/client.ts`) plus the `streamChat` SSE helper
  (`src/api/sse.ts`). Both take injectable transports (`fetch`, `EventSource`), so
  components render identically in production (real backend) and in tests (offline
  fakes).
- **Restated wire types.** The client **restates** the backend's snake_case DTOs
  locally (`src/api/types.ts`) — it never imports from `@kgpacks/backend`. The two
  stay aligned by contract, exactly as the Python frontend tracked the FastAPI
  service. Field names are byte-for-byte the backend's (`max_results`,
  `query_type`, `execution_time_ms`, `word_count`, …).
- **Drop-in compatible.** Because the backend
  [preserves the Python route contract and JSON shapes](./backend.md#http-api-reference),
  this client is a faithful retarget of the original SPA's client at the same
  `/api/v1` surface.

## Contents

- [Status](#status)
- [Architecture at a glance](#architecture-at-a-glance)
- [Workspace placement](#workspace-placement)
- [Installation & scripts](#installation--scripts)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API client reference](#api-client-reference)
  - [Constructing the client](#constructing-the-client)
  - [Wire types](#wire-types)
  - [`chat`](#chat)
  - [`streamChat` (SSE)](#streamchat-sse)
  - [`search`](#search)
  - [`hybridSearch`](#hybridsearch)
  - [`graph`](#graph)
  - [`getArticle`](#getarticle)
  - [`autocomplete` / `categories` / `stats` / `health`](#autocomplete--categories--stats--health)
- [Error model — `ApiClientError`](#error-model--apiclienterror)
- [UI](#ui)
  - [`useChatStream` hook](#usechatstream-hook)
  - [`ChatPanel`](#chatpanel)
  - [`SearchBox`](#searchbox)
  - [`ResultsView`](#resultsview)
- [Build & output](#build--output)
- [Testing strategy](#testing-strategy)
- [Security model](#security-model)
- [See also](#see-also)

## Status

> This document and the
> [package README](../../apps/frontend/README.md) describe the shipped app. The
> Vite + React 18 + strict-TS SPA, the typed `ApiClient`, the `streamChat` SSE
> helper, the `useChatStream` hook, and the `ChatPanel` / `SearchBox` /
> `ResultsView` components are live and covered by offline Vitest suites (mocked
> `fetch` + a fake `EventSource`) plus a Playwright smoke test. See
> [docs/PLAN.md](../PLAN.md) (step 10, _frontend migration_) and
> [docs/monorepo.md](../monorepo.md) for workspace conventions.

It builds on [`@kgpacks/backend`](./backend.md) as its only contract dependency,
keeps its runtime dependency surface to **`react` + `react-dom`** (no d3, no UI
framework, no data-fetching library), and contains **no Python** — the
`apps/` placement is unrelated to the python-free guard, which only scans
`packages/*`.

## Architecture at a glance

```
            ┌──────────────────────── apps/frontend (SPA) ────────────────────────┐
            │                                                                      │
  user ─▶  App ─▶ ChatPanel ─▶ useChatStream ─▶ streamChat() ─▶ EventSource ──┐    │
            │     SearchBox ─▶ ApiClient.search()/graph() ─▶ fetch() ──┐      │    │
            │     ResultsView ◀── plain-text render (no innerHTML) ◀────┘      │    │
            └──────────────────────────────────────────────────────────────────┼──┘
                                                                                │
                          GET /api/v1/chat/stream (SSE)  ·  POST /api/v1/chat   │
                          GET /api/v1/search · /graph · /hybrid-search · …  ◀────┘
                                            @kgpacks/backend  (/api/v1)
```

- **Blocking calls** (`search`, `hybrid-search`, `graph`, `articles`,
  `autocomplete`, `categories`, `stats`, `health`, and the non-streaming
  `POST /chat`) go through `ApiClient` over `fetch`.
- **Streaming chat** goes through `streamChat` over the browser-native
  `EventSource`, consuming the backend's `sources → token → done` event sequence.
- **All untrusted text** (answers, tokens, source titles, article/graph labels) is
  rendered as **React text nodes only** — never via `dangerouslySetInnerHTML`. See
  [Security model](#security-model).

## Workspace placement

The frontend is the workspace's first **application**, so it introduces an
`apps/` tree alongside `packages/`:

```text
.
├── pnpm-workspace.yaml        # globs: packages/*, parity/*, AND apps/*
├── packages/                  # libraries (@kgpacks/db, …, @kgpacks/backend)
└── apps/
    └── frontend/              # @kgpacks/frontend — Vite + React 18 SPA
        ├── package.json
        ├── .gitignore             # dist/, .env.local, node_modules
        ├── .env.example           # committed; documents VITE_API_BASE_URL
        ├── tsconfig.json          # standalone strict config (DOM + bundler + JSX)
        ├── tsconfig.node.json     # config files (vite.config.ts, etc.)
        ├── vite.config.ts
        ├── vitest.config.ts
        ├── playwright.config.ts
        ├── index.html
        ├── env.d.ts               # Vite/`import.meta.env` ambient types
        ├── src/
        │   ├── main.tsx           # React root
        │   ├── App.tsx            # composes ChatPanel + SearchBox + ResultsView
        │   ├── api/
        │   │   ├── types.ts       # restated backend wire DTOs
        │   │   ├── client.ts      # ApiClient (fetch)
        │   │   ├── sse.ts         # streamChat (EventSource)
        │   │   └── errors.ts      # ApiClientError + status→code map
        │   ├── hooks/
        │   │   └── useChatStream.ts
        │   ├── components/
        │   │   ├── ChatPanel.tsx
        │   │   ├── SearchBox.tsx
        │   │   └── ResultsView.tsx
        │   └── __tests__/
        │       ├── client.test.ts
        │       ├── streamChat.test.ts
        │       └── search.test.ts
        └── e2e/
            └── smoke.spec.ts      # Playwright build-and-render smoke
```

**Why `apps/`, not `packages/`?**

1. **It's an app, not a library.** Nothing imports `@kgpacks/frontend`; it ships a
   static bundle. `apps/` is the idiomatic home for deployables.
2. **Governance scope.** The structural suites
   ([`test/scaffold.test.ts`](../../test/scaffold.test.ts)) and the python-free
   guard ([`scripts/check-no-python.mjs`](../../scripts/check-no-python.mjs)) only
   scan `packages/*`. The frontend pulls in browser/JSX globals and dev-only tools
   (Vite, Playwright) that those package-shaped suites do not expect, so it lives
   under `apps/` and is intentionally out of their scope. The frontend is still
   covered by `pnpm -r build`, `pnpm -r test`, `pnpm -r typecheck`, repo-wide
   `eslint .`, and `prettier --check .`.

`pnpm-workspace.yaml` is extended to include the new tree while preserving the
existing globs:

```yaml
packages:
  - packages/*
  - parity/*
  - apps/*
```

The package keeps the `@kgpacks/` scope — `@kgpacks/frontend` — for consistency,
which is safe because the `packages/*`-scoped governance suites match on the
**path**, not the name.

### ESLint: the `apps/**` browser/JSX override

The repo runs `eslint .` across the whole tree with a flat config whose default
language options enable **only** Node globals and match `**/*.{ts,js,…}` (no
`.tsx`). Browser code under `apps/` would otherwise fail `no-undef` on
`document`, `window`, `EventSource`, `import.meta`, etc., and on JSX syntax. A
single **additive** override block scopes browser + JSX language options to the
app without weakening any rule elsewhere:

```js
// eslint.config.js (additive block — existing config unchanged)
{
  files: ['apps/**/*.{ts,tsx}'],
  languageOptions: {
    globals: { ...globals.browser },
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
}
```

## Installation & scripts

`@kgpacks/frontend` is an internal workspace app. It is developed with the same
toolchain as the rest of the monorepo (Node 22 LTS, the pinned pnpm@9 via
Corepack — see [docs/monorepo.md](../monorepo.md#prerequisites)).

| Script      | Command                | What it does                                                     |
| ----------- | ---------------------- | ---------------------------------------------------------------- |
| `dev`       | `vite`                 | Start the Vite dev server (HMR) with the `/api/v1` proxy.        |
| `build`     | `tsc -b && vite build` | Type-check, then emit the production bundle to `dist/`.          |
| `preview`   | `vite preview`         | Serve the built `dist/` locally to sanity-check production.      |
| `typecheck` | `tsc -b --noEmit`      | Strict type-check; wired into `pnpm -r typecheck`.               |
| `test`      | `vitest run`           | Run the jsdom unit suite; wired into `pnpm -r test`.             |
| `test:e2e`  | `playwright test`      | Run the Playwright smoke test. **Excluded** from `pnpm -r test`. |

```bash
pnpm --filter @kgpacks/frontend dev        # local dev server (default :5173)
pnpm --filter @kgpacks/frontend build      # production bundle → apps/frontend/dist
pnpm --filter @kgpacks/frontend test       # vitest (offline, jsdom)
pnpm --filter @kgpacks/frontend test:e2e   # Playwright smoke (browser download)
pnpm --filter @kgpacks/frontend typecheck
```

> **Why `test:e2e` is separated.** Playwright downloads a browser binary on first
> run, which would make the recursive `pnpm -r test` slow and flaky in CI. The
> recursive suite runs only the fast, offline Vitest specs; the smoke test is run
> explicitly via `test:e2e`. This keeps `pnpm -r build`, `pnpm -r test`, and
> `pnpm -r typecheck` green for the whole workspace, frontend included.

### Dependencies

| Kind      | Packages                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime` | `react`, `react-dom`                                                                                                                       |
| `dev`     | `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@playwright/test` |

No d3, no charting library, no UI framework, no HTTP client — the dependency
surface is deliberately minimal. The graph view is rendered as a plain text list
(see [`ResultsView`](#resultsview)); upgrading to a visual graph is a future,
isolated change behind the same `ApiClient.graph()` data contract.

## Quick start

1. **Start the backend** (see [docs/packages/backend.md](./backend.md#quick-start)),
   listening on `http://127.0.0.1:8000`. Its default CORS allow-list already
   includes the Vite dev origin `http://localhost:5173`.

   ```bash
   WIKIGR_DATABASE_PATH=./pack.lbug WIKIGR_PORT=8000 node packages/backend/dist/index.js
   ```

2. **Start the frontend** dev server:

   ```bash
   pnpm --filter @kgpacks/frontend dev
   # ➜  Local:   http://localhost:5173/
   ```

   In dev, Vite proxies `/api/v1/*` to the backend (see
   [Configuration](#configuration)), so the app uses **same-origin relative URLs**
   and no CORS round-trips are needed.

3. **Use the app.** Type a question into the chat panel and press Enter — the
   answer streams in token-by-token as the backend emits SSE frames, with the
   cited sources shown first. Type into the search box to run a semantic search
   and inspect the graph neighborhood of any result.

To preview a production build:

```bash
pnpm --filter @kgpacks/frontend build
pnpm --filter @kgpacks/frontend preview     # serves apps/frontend/dist
```

## Configuration

All configuration is build-time via Vite environment variables. Only the
`VITE_`-prefixed variables below are read; **all `VITE_*` values are inlined into
the public bundle**, so they must never contain secrets. LLM/provider credentials
live exclusively on the backend.

| Variable            | Type   | Default | Description                                                                                                     |
| ------------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | string | `''`    | Base URL prepended to every API path. Empty string = **same-origin** (use the dev proxy or co-host the bundle). |

- **Development:** leave `VITE_API_BASE_URL` unset. `vite.config.ts` proxies
  `/api/v1` → `http://localhost:8000`:

  ```ts
  // vite.config.ts (excerpt)
  server: {
    proxy: {
      '/api/v1': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  ```

- **Production, same origin:** serve the static `dist/` from the same host as the
  backend (or behind one reverse proxy) and leave `VITE_API_BASE_URL` empty.

- **Production, cross origin:** set `VITE_API_BASE_URL=https://api.example.com` at
  build time and add that origin to the backend's `WIKIGR_CORS_ORIGINS` (see
  [backend configuration](./backend.md#configuration)).

```bash
# Cross-origin production build
VITE_API_BASE_URL=https://api.example.com pnpm --filter @kgpacks/frontend build
```

Create local overrides in `apps/frontend/.env.local` (git-ignored). All `.env*`
files except a committed `.env.example` are ignored.

## API client reference

The client targets the backend's [`/api/v1` contract](./backend.md#http-api-reference)
exactly. Paths are joined as `` `${baseUrl}/api/v1/...` ``. Every method returns a
typed `Promise`; any non-`2xx` response is decoded from the backend's
[error envelope](./backend.md#error-model) and thrown as an
[`ApiClientError`](#error-model--apiclienterror).

### Constructing the client

```ts
import { ApiClient } from './api/client';

// Default: same-origin (or the dev proxy), browser fetch + EventSource.
export const api = new ApiClient();

// Explicit base URL and injected transports (used by tests).
const testClient = new ApiClient({
  baseUrl: 'http://api.test',
  fetch: fakeFetch, // any (input, init) => Promise<Response>
  eventSourceFactory: (url) => new FakeEventSource(url), // (url: string) => EventSourceLike
});
```

```ts
interface ApiClientOptions {
  /** Base URL prefix. Defaults to import.meta.env.VITE_API_BASE_URL ?? ''. */
  baseUrl?: string;
  /** Per-attempt timeout for blocking HTTP calls. Default 15000ms. */
  timeoutMs?: number;
  /** Retries for transient idempotent HTTP failures. Default 2. */
  maxRetries?: number;
  /** Initial exponential-backoff delay. Default 250ms. */
  retryBaseDelayMs?: number;
  /** Injectable fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Injectable EventSource constructor for streamChat. Defaults to globalThis.EventSource. */
  eventSourceFactory?: (url: string) => EventSourceLike;
}
```

All query/path parameters are URL-encoded (`URLSearchParams` /
`encodeURIComponent`) before they hit the wire — including the SSE `question` on
the `GET /chat/stream` URL — so user input can never break path, query, or SSE
framing.

### Wire types

Restated from the [backend contract](./backend.md#http-api-reference) — identical
field names and casing. These types live in `src/api/types.ts` and are the single
source of truth for the UI.

> **`query_type` is typed as `string`, not the literal `'vector_search'`.** The
> backend returns `"vector_search"` in Phase 1, but the client only renders this
> value as an opaque label — it never branches on it. Keeping `string` avoids a
> breaking type change when future query strategies are added. This is an
> intentional, reviewed deviation from the backend's literal type.

```ts
// ─── Chat ───────────────────────────────────────────────────────────────────
export interface ChatRequest {
  question: string; // length 1–500
  pack?: string; // ^[a-z0-9][a-z0-9-]*$ (Phase 1: default pack only)
  max_results?: number; // 1–50, default 10
}

export interface ChatResponse {
  answer: string;
  sources: string[];
  query_type: string; // stable label, "vector_search" in Phase 1
  execution_time_ms: number;
}

export interface StreamChatRequest {
  question: string; // length 1–500
  max_results?: number; // 1–50, default 10
}

export interface StreamDone {
  query_type: string;
  execution_time_ms: number;
}

// ─── Search / hybrid-search ───────────────────────────────────────────────────
export interface SearchResult {
  article: string;
  similarity: number; // [0, 1]
  category: string | null;
  word_count: number;
  summary: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total: number;
  execution_time_ms: number;
}

// ─── Graph ────────────────────────────────────────────────────────────────────
export interface GraphNode {
  id: string;
  title: string;
  category: string | null;
  word_count: number;
  depth: number; // 0 = seed
  links_count: number;
  summary: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string; // "internal"
  weight: number; // 1
}

export interface GraphResponse {
  seed: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  total_nodes: number;
  total_edges: number;
  execution_time_ms: number;
}

// ─── Article detail ───────────────────────────────────────────────────────────
export interface ArticleSection {
  title: string;
  content: string;
  word_count: number;
  level: number;
}

export interface ArticleDetail {
  title: string;
  category: string | null;
  word_count: number;
  sections: ArticleSection[];
  links: string[];
  backlinks: string[];
  categories: string[];
  wikipedia_url: string;
  last_updated: string; // ISO-8601 …Z
}

// ─── Autocomplete / categories / stats / health ──────────────────────────────
export interface AutocompleteSuggestion {
  title: string;
  category: string | null;
  match_type: 'prefix' | 'contains';
}
export interface AutocompleteResponse {
  query: string;
  suggestions: AutocompleteSuggestion[];
  total: number;
}

export interface CategoryCount {
  name: string;
  article_count: number;
}
export interface CategoriesResponse {
  categories: CategoryCount[];
  total: number;
}

export interface StatsResponse {
  articles: {
    total: number;
    by_category: Record<string, number>;
    by_depth: Record<string, number>;
  };
  sections: { total: number; avg_per_article: number };
  links: { total: number; avg_per_article: number };
  database: { size_mb: number; last_updated: string | null };
  performance: unknown | null;
}

export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  version: string;
  database: 'connected' | 'disconnected';
  timestamp: string;
}
```

### `chat`

Blocking chat over `POST /api/v1/chat`. Use [`streamChat`](#streamchat-sse) for
the token-streaming UI; this method is for non-streaming callers and tests.

```ts
chat(req: ChatRequest): Promise<ChatResponse>;
```

```ts
const res = await api.chat({ question: 'What is quantum entanglement?', max_results: 8 });
res.answer; // string
res.sources; // string[]
```

- **Sends** `application/json` with `{ question, pack?, max_results? }`.
- **Throws** `ApiClientError` for `400 INVALID_PARAMETER` / `MISSING_PARAMETER`,
  `400 INVALID_PACK_NAME`, `404 PACK_NOT_FOUND`, `429 RATE_LIMITED`,
  `503 AGENT_UNAVAILABLE`, or `500 AGENT_ERROR`.

### `streamChat` (SSE)

Token-streaming chat over `GET /api/v1/chat/stream`, consuming the backend's
[SSE protocol](./backend.md#server-sent-events-protocol). `streamChat` opens an
`EventSource`, dispatches the `sources → token → done` sequence to your handlers,
maps the failure cases to an `ApiClientError`, and **always closes the connection**
on `done`, on error, and when you call `controller.close()`.

```ts
streamChat(req: StreamChatRequest, handlers: StreamHandlers): StreamController;

interface StreamHandlers {
  /** event: sources — JSON array of cited article titles. */
  onSources?(titles: string[]): void;
  /** event: token — answer text. Treated additively (concatenate). */
  onToken?(text: string): void;
  /** event: done — final metadata; the stream is closed immediately after. */
  onDone?(done: StreamDone): void;
  /** Terminal error (in-stream error event, or pre-stream service failure). */
  onError?(err: ApiClientError): void;
}

interface StreamController {
  /** Idempotently close the EventSource (e.g. on React unmount or cancel). */
  close(): void;
}
```

```ts
const controller = api.streamChat(
  { question: 'What is entanglement?', max_results: 8 },
  {
    onSources: (titles) => setSources(titles),
    onToken: (text) => setAnswer((prev) => prev + text),
    onDone: ({ execution_time_ms }) => setElapsed(execution_time_ms),
    onError: (err) => setError(err.message),
  },
);
// later, to cancel:
controller.close();
```

**Event handling**

| Backend event                   | `data` payload                                                     | Client behavior                                                            |
| ------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `sources`                       | JSON `string[]`                                                    | `JSON.parse` (guarded) → `onSources`.                                      |
| `token`                         | answer text (full answer in one event, see below)                  | `onToken(text)`; the UI concatenates.                                      |
| `done`                          | JSON `{ query_type, execution_time_ms }`                           | `onDone`, then `close()`.                                                  |
| `error` (in-stream)             | error class name, e.g. `"TimeoutError"`                            | map to `ApiClientError` (`TIMEOUT` / `AGENT_ERROR`) → `onError`.           |
| _pre-stream connection failure_ | _(no named event; `EventSource` `onerror` fires before any frame)_ | map to `ApiClientError` code `NETWORK_ERROR` → `onError` (see note below). |

> **`token` is currently one event.** The backend emits the **full** answer in a
> single `token` frame (it is not yet incremental). The client nonetheless treats
> `token` **additively** — `onToken` appends — so the same UI is forward-compatible
> with future per-token streaming with no changes.

> **Pre-stream failure is reported as a transport error, not a precise `503`.**
> The backend does emit a **`503` JSON envelope _before_ the stream opens** when the
> agent is unavailable (see the [backend SSE protocol](./backend.md#server-sent-events-protocol)).
> But the browser's native `EventSource` exposes **no status code and no body** to
> the client — a pre-stream `503` and a genuine transport failure (backend down,
> DNS, CORS) both surface only as an `onerror` with `readyState === CLOSED` and no
> prior named event. `streamChat` therefore cannot tell these apart and honestly
> reports any such "error before the first named event" as a transport-level
> `ApiClientError { code: 'NETWORK_ERROR', status: null }` — the same code used for
> every other unreachable-service case. The UI presents `NETWORK_ERROR` with a
> retry/"service may be unavailable" hint.
>
> An `error` event that arrives _after_ `sources`/`token` is an **in-stream** failure
> and is mapped from its class name to `TIMEOUT` (`"TimeoutError"`) or `AGENT_ERROR`
> (`"AgentError"`).
>
> When a caller needs the precise `503 AGENT_UNAVAILABLE` distinction (e.g. to show a
> "service is starting up" message), use the blocking [`chat`](#chat) method instead:
> it reads the real HTTP status and envelope, so it surfaces `AGENT_UNAVAILABLE`
> exactly.

**Hardening.** Every `JSON.parse` is wrapped (a malformed `sources`/`done` payload
becomes an `ApiClientError`, never an unhandled throw); the accumulated answer
length and event count are bounded; and the `EventSource` is closed exactly once
in all terminal paths.

### `search`

Semantic (vector) search over `GET /api/v1/search`.

```ts
search(params: {
  query: string; // length ≤ 200 (a seed article title)
  category?: string; // length ≤ 200
  limit?: number; // 1–100, default 10
  threshold?: number; // 0–1, default 0
}): Promise<SearchResponse>;
```

```ts
const res = await api.search({ query: 'Quantum entanglement', limit: 5 });
res.results[0].article; // "Bell's theorem"
res.results[0].similarity; // 0.91
```

- **Throws** `ApiClientError` `400` for invalid params; `404 NOT_FOUND` when the
  seed article does not exist.

### `hybridSearch`

Vector + graph-proximity search over `GET /api/v1/hybrid-search`. Same
`SearchResponse` shape as [`search`](#search); `summary` is `""` for hybrid
results.

```ts
hybridSearch(params: {
  query: string; // length ≤ 200
  category?: string;
  max_hops?: number; // 1–3, default 2
  limit?: number; // 1–100, default 10
}): Promise<SearchResponse>;
```

### `graph`

Graph neighborhood over `GET /api/v1/graph`.

```ts
graph(params: {
  article: string; // length ≤ 500 (seed)
  depth?: number; // 1–3, default 2
  limit?: number; // 1–200, default 50
  category?: string;
}): Promise<GraphResponse>;
```

```ts
const g = await api.graph({ article: 'Quantum entanglement', depth: 2, limit: 50 });
g.nodes; // GraphNode[] ordered by depth then title
g.edges; // GraphEdge[]
```

- **Throws** `ApiClientError` `400` for invalid params (including `depth` outside
  `[1, 3]`); `404 NOT_FOUND` for an unknown seed.

### `getArticle`

Full article detail over `GET /api/v1/articles/:title`. The title is
`encodeURIComponent`-encoded into the path.

```ts
getArticle(title: string): Promise<ArticleDetail>;
```

```ts
const a = await api.getArticle('Quantum entanglement');
a.sections; // ArticleSection[]
a.links; // string[]
```

- **Throws** `ApiClientError` `404 NOT_FOUND` when the article does not exist.

### `autocomplete` / `categories` / `stats` / `health`

Supporting endpoints used by the search box and status surfaces.

```ts
autocomplete(params: { q: string /* length 2–200 */; limit?: number /* 1–20, default 10 */ }):
  Promise<AutocompleteResponse>;

categories(): Promise<CategoriesResponse>;
stats(): Promise<StatsResponse>;
health(): Promise<HealthResponse>;
```

- `autocomplete` **throws** `ApiClientError` `400 INVALID_PARAMETER` when `q` is
  shorter than two characters (the `SearchBox` therefore only fires at ≥ 2 chars).
- `health` resolves with the body for both `200` (healthy) and `503` (unhealthy)
  rather than throwing, so a status indicator can render either state — read
  `res.status` / `res.database`.

## Error model — `ApiClientError`

A single error type carries everything the UI needs. It is constructed from the
backend [error envelope](./backend.md#error-model) on any non-`2xx` response, and
synthesized for transport/parse failures and the SSE error paths.

```ts
export type ApiErrorCode =
  | 'MISSING_PARAMETER'
  | 'INVALID_PARAMETER'
  | 'INVALID_PACK_NAME'
  | 'NOT_FOUND'
  | 'PACK_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'AGENT_UNAVAILABLE'
  | 'AGENT_ERROR'
  | 'TIMEOUT' // SSE: "TimeoutError"
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR'; // fetch reject / EventSource pre-stream failure — transport-level, no HTTP envelope

export class ApiClientError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null; // HTTP status, or null for transport/SSE failures
  readonly details: unknown | null; // envelope `error.details`, if any
}
```

- **From an HTTP envelope:** `code`, `message`, and `details` are taken from
  `{ error: { code, message, details }, timestamp }`; `status` is the HTTP status.
- **Status → code fallback.** If a non-`2xx` response is not a well-formed
  envelope, the code is inferred from the status: `400 → INVALID_PARAMETER`,
  `404 → NOT_FOUND`, `429 → RATE_LIMITED`, `503 → AGENT_UNAVAILABLE`, anything else
  → `INTERNAL_ERROR`.
- **Transport failures** (`fetch` rejecting, DNS, offline) become
  `code: 'NETWORK_ERROR'`, `status: null`.
- **Timeouts** become `code: 'TIMEOUT'`, `status: null`. Idempotent blocking
  requests (`GET`/`HEAD`) retry transient transport failures and HTTP
  `408`/`425`/`429`/`5xx` responses with bounded exponential backoff, respecting
  `Retry-After`. `POST /chat` and SSE streams are never replayed automatically.
- **SSE failures** map as described in [`streamChat`](#streamchat-sse):
  in-stream `"TimeoutError"` → `TIMEOUT`, `"AgentError"` → `AGENT_ERROR`. A
  **pre-stream** connection failure is reported as `NETWORK_ERROR` (the browser's
  `EventSource` cannot expose the backend's pre-stream `503` status); the precise
  `AGENT_UNAVAILABLE` is available via the blocking [`chat`](#chat) method.

The UI renders **`error.message` only** — never `details`, stack traces, or raw
console dumps — and uses `code` to decide presentation (e.g. a back-off hint for
`RATE_LIMITED`, a "service starting up" note for `AGENT_UNAVAILABLE`, and a
retry/"service may be unavailable" hint for `NETWORK_ERROR`).

## UI

The app is intentionally small: `App.tsx` composes three components and owns the
`ApiClient` instance, which it passes down as a prop (so tests inject a fake-backed
client). Layout/styling is minimal, plain CSS — the focus is the data contract and
the streaming UX, not visual design.

### `useChatStream` hook

Encapsulates the [`streamChat`](#streamchat-sse) lifecycle for React: it tracks
the accumulating answer, the cited sources, the streaming/done/error state, and
tears the `EventSource` down on unmount or when a new question supersedes the
current stream.

```ts
function useChatStream(api: ApiClient): {
  state: 'idle' | 'streaming' | 'done' | 'error';
  answer: string;
  sources: string[];
  doneMeta: StreamDone | null;
  error: ApiClientError | null;
  ask(req: StreamChatRequest): void; // starts/replaces the stream
  reset(): void;
};
```

- `ask` opens a new stream, first closing any in-flight one (single active stream).
- `onToken` appends to `answer`; `onSources` sets `sources`; `onDone` sets
  `doneMeta` and `state = 'done'`; `onError` sets `error` and `state = 'error'`.
- The hook closes the stream in a `useEffect` cleanup on unmount — no dangling
  `EventSource`.

### `ChatPanel`

The streaming chat surface. Renders a question `<form>` (disabled while
`state === 'streaming'` to prevent overlap and respect rate limits), the cited
sources as a list, and the answer as it accumulates. On error it shows
`error.message` and re-enables the form. All answer/source text is rendered as
React text nodes.

```tsx
<ChatPanel api={api} />
```

### `SearchBox`

A debounced search input (≈ 250 ms) that calls
[`autocomplete`](#autocomplete--categories--stats--health) for suggestions (only
once the query is ≥ 2 chars) and, on submit, runs [`search`](#search) and lifts
the `SearchResponse` to `App` for display. In-flight submits are disabled.

```tsx
<SearchBox api={api} onResults={(res) => setResults(res)} />
```

### `ResultsView`

Renders search results and, on selecting a result, its
[`graph`](#graph) neighborhood — both as **plain text lists** (no d3, no SVG):
results show `article`, `similarity`, `category`, and `summary`; the graph view
lists nodes (by `depth`/`title`) and edges (`source → target`). Every label is a
React text node. This is the seam where a future visual graph component can drop
in behind the unchanged `GraphResponse` contract.

```tsx
<ResultsView results={results} graph={graph} onSelect={(title) => loadGraph(title)} />
```

## Build & output

```bash
pnpm --filter @kgpacks/frontend build
```

- `tsc -b` runs in **project-build mode**: `tsconfig.json` is a `composite`
  project that `references` `tsconfig.node.json` (config files), so a single
  `tsc -b` strict type-checks both. `vite build` then emits a hashed, minified,
  tree-shaken bundle to `apps/frontend/dist/` (`index.html` + `assets/`).
- `dist/` is git-ignored and already covered by the repo's
  [`.prettierignore`](../../.prettierignore) `dist/` entry, so the build artifact
  never trips `prettier --check .`.
- The standalone strict `tsconfig.json` does **not** extend
  `tsconfig.base.json` (which targets Node/`NodeNext`). The frontend needs a
  browser/bundler profile instead:

  | Option                 | Value                                  | Why                                                                                       |
  | ---------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
  | `strict`               | `true`                                 | Full strictness, parity with the rest of the repo.                                        |
  | `jsx`                  | `react-jsx`                            | The automatic JSX runtime (no `React` import needed).                                     |
  | `module`               | `ESNext`                               | Vite/bundler module output.                                                               |
  | `moduleResolution`     | `bundler`                              | Bundler resolution — no `.js` extensions on imports.                                      |
  | `lib`                  | `["DOM", "DOM.Iterable", "ES2022"]`    | Browser + modern JS APIs.                                                                 |
  | `verbatimModuleSyntax` | `true`                                 | Forces `import type` for type-only imports.                                               |
  | `composite`            | `true`                                 | Required by `tsc -b` project-build mode (also on `tsconfig.node.json`).                   |
  | `references`           | `[{ "path": "./tsconfig.node.json" }]` | Top-level (not a compiler option) — lets one `tsc -b` also check the Node/config project. |

  > Because `verbatimModuleSyntax` is on, type-only imports **must** use
  > `import type { … }` — e.g. `import type { ChatResponse } from './api/types'`.

## Testing strategy

All unit tests run **offline** with [Vitest](https://vitest.dev) in a **jsdom**
environment — no real network, no backend, no browser download. The Playwright
smoke test is separate and opt-in.

- **`client.test.ts`** — drives `ApiClient` with a **mocked `fetch`**. Asserts:
  the correct method/URL/headers and encoded query string per endpoint;
  request-body shape for `POST /chat`; happy-path decoding into the typed
  responses; and that a `4xx`/`5xx` envelope becomes an `ApiClientError` with the
  right `code`/`status` (and that a non-envelope error falls back via the
  status→code map).
- **`streamChat.test.ts`** — drives `streamChat` with a **fake `EventSource`**.
  Asserts the success ordering `sources → token → done` (and that `onToken`
  concatenates), that the connection is closed after `done`; the **in-stream**
  error path (`event: error` / `data: TimeoutError` → `onError` with code
  `TIMEOUT`); and the **pre-stream** path (an `onerror` before any named event →
  `onError` with code `NETWORK_ERROR`, since the status is unreadable). Also covers
  `controller.close()` idempotency and guarded `JSON.parse`.
- **`search.test.ts`** — `search`/`hybridSearch`/`graph` happy paths and the
  `404 NOT_FOUND` mapping, plus parameter encoding for titles containing spaces
  and reserved characters.
- **`e2e/smoke.spec.ts`** (Playwright, `test:e2e`) — builds/serves the app and
  asserts it renders: the **chat panel** is visible and its input is interactable.
  This is a build-and-render smoke check, not a backend integration test.

```bash
pnpm --filter @kgpacks/frontend test       # vitest (part of pnpm -r test)
pnpm --filter @kgpacks/frontend test:e2e   # Playwright smoke (opt-in)
```

## Security model

The frontend is a static, credential-free SPA. The dominant risk is **XSS via
untrusted content** (model answers, source titles, article/graph labels), so the
app is built to neutralize it:

- **No raw HTML.** All dynamic text renders as React text nodes. The app contains
  **no** `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or dynamic `<script>`
  injection. (If Markdown rendering is ever added, it must disable raw HTML and
  sanitize with DOMPurify; links are restricted to `http(s)` with
  `rel="noopener noreferrer"`.)
- **Encoded URLs everywhere.** Every path/query value — including the SSE
  `question` on `GET /chat/stream` — is encoded via `URLSearchParams` /
  `encodeURIComponent`, so input can't inject into the path, query, or SSE framing.
- **No credentials on the wire.** `fetch` omits credentials and `EventSource` runs
  with `withCredentials: false`; there is no cookie/CSRF surface.
- **No secrets in the bundle.** Only `VITE_API_BASE_URL` (public by definition) is
  read; provider/LLM keys stay server-side. All `.env*` files (except
  `.env.example`) are git-ignored.
- **Streaming hardening.** `JSON.parse` is guarded, accumulated answer length and
  event count are bounded, and the `EventSource` is always closed on
  done/error/unmount.
- **Abuse/back-pressure.** Submit buttons disable while a request is in flight;
  autocomplete is debounced; `429`/`503` are surfaced as friendly, code-driven
  messages (never raw `details`).
- **Deployment CSP (recommended).** Serve the SPA with a strict
  Content-Security-Policy, e.g.
  `default-src 'self'; connect-src 'self' https://<api-host>; script-src 'self'; frame-ancestors 'none'; object-src 'none'`.
  (The backend's own `default-src 'none'` CSP applies to API responses, not to the
  HTML app shell.)

## See also

- [`apps/frontend/README.md`](../../apps/frontend/README.md) — overview and quick start.
- [`docs/packages/backend.md`](./backend.md) — the `/api/v1` HTTP contract, SSE
  protocol, error model, and CORS/config that this client targets.
- [`docs/monorepo.md`](../monorepo.md) — workspace layout, the `apps/*` glob, the
  `apps/**` ESLint override, and the everyday build/test/lint commands.
- [`docs/PLAN.md`](../PLAN.md) — the end-to-end port plan (the frontend migration
  is step 10).
