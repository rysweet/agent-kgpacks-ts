# @kgpacks/frontend

The web **frontend** of the agent-kgpacks TypeScript port: a
[Vite](https://vite.dev) + [React 18](https://react.dev) + **strict TypeScript**
single-page app that talks to [`@kgpacks/backend`](../../packages/backend)'s
`/api/v1` API. It offers a streaming **chat panel** (Server-Sent Events), a
**search box**, and a lightweight **results / graph view**, reproducing the
API-client contract of the original Python repo's React SPA
([`rysweet/agent-kgpacks/frontend/`](https://github.com/rysweet/agent-kgpacks))
without copying its code.

> This README and
> [docs/packages/frontend.md](../../docs/packages/frontend.md) describe the shipped
> app. The SPA, the typed `ApiClient`, the `streamChat` SSE helper, the
> `useChatStream` hook, and the `ChatPanel` / `SearchBox` / `ResultsView`
> components are live and covered by offline Vitest suites (mocked `fetch` + a fake
> `EventSource`) plus a Playwright smoke test.

Unlike the libraries under `packages/`, the frontend is a **deployable app** and
lives under **`apps/`** — which also keeps it out of the repo's `packages/*`-only
structural suites. It depends only on `react` + `react-dom` at runtime (no d3, no
UI framework, no HTTP client) and contains **no Python**.

## Architecture at a glance

```
  ChatPanel  ─▶ useChatStream ─▶ streamChat() ─▶ EventSource ─▶ GET /api/v1/chat/stream (SSE)
  SearchBox  ─▶ ApiClient.search()/autocomplete() ─▶ fetch() ─▶ GET /api/v1/search · /autocomplete
  ResultsView ◀─ plain-text render (no innerHTML) ◀─ ApiClient.graph() ─▶ GET /api/v1/graph
                                                                        @kgpacks/backend (/api/v1)
```

- **One public seam:** a typed `ApiClient` (`src/api/client.ts`) over `fetch`, plus
  `streamChat` (`src/api/sse.ts`) over the browser-native `EventSource`. Both take
  injectable transports, so components render identically against the real backend
  and against offline fakes in tests.
- **Restated wire types:** `src/api/types.ts` restates the backend's snake_case
  DTOs (it never imports `@kgpacks/backend`); the two stay aligned by contract.
- **Every failure** is normalized into a single `ApiClientError` carrying `code`,
  `status`, and `message` (from the backend's `{ error, timestamp }` envelope).

## Quick start

Start the backend first (default CORS already allows the Vite dev origin
`http://localhost:5173`):

```bash
WIKIGR_DATABASE_PATH=./pack.lbug WIKIGR_PORT=8000 node packages/backend/dist/index.js
```

Then start the frontend dev server (Vite proxies `/api/v1` → `:8000`):

```bash
pnpm --filter @kgpacks/frontend dev        # ➜ http://localhost:5173/
```

Type a question into the chat panel — the answer streams in token-by-token, with
cited sources first — and use the search box to explore the graph neighborhood of
any result.

## Configuration

Build-time via Vite env vars (all `VITE_*` values are public — never put secrets
here; LLM keys stay on the backend).

| Variable            | Default | Description                                                                                                                                                |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | `''`    | Prefix for every API path. Empty = same-origin (dev proxy or co-hosted bundle). Set to e.g. `https://api.example.com` for a cross-origin production build. |

## Scripts

| Script      | Command                | Notes                                                    |
| ----------- | ---------------------- | -------------------------------------------------------- |
| `dev`       | `vite`                 | Dev server with HMR + `/api/v1` proxy.                   |
| `build`     | `tsc -b && vite build` | Strict type-check then production bundle → `dist/`.      |
| `preview`   | `vite preview`         | Serve the built bundle locally.                          |
| `typecheck` | `tsc -b --noEmit`      | Part of `pnpm -r typecheck`.                             |
| `test`      | `vitest run`           | Offline jsdom unit tests; part of `pnpm -r test`.        |
| `test:e2e`  | `playwright test`      | Playwright smoke test. **Excluded** from `pnpm -r test`. |

```bash
pnpm --filter @kgpacks/frontend build      # production bundle → apps/frontend/dist
pnpm --filter @kgpacks/frontend test       # vitest (offline)
pnpm --filter @kgpacks/frontend test:e2e   # Playwright smoke (downloads a browser)
pnpm --filter @kgpacks/frontend typecheck
```

`test:e2e` is kept out of the recursive suite so `pnpm -r build`, `pnpm -r test`,
and `pnpm -r typecheck` stay fast and green for the whole workspace.

## API client (at a glance)

```ts
import { ApiClient } from './api/client';

const api = new ApiClient(); // baseUrl = VITE_API_BASE_URL ?? ''

await api.chat({ question: 'What is entanglement?', max_results: 8 }); // POST /chat
await api.search({ query: 'Quantum entanglement', limit: 5 }); // GET /search
await api.graph({ article: 'Quantum entanglement', depth: 2 }); // GET /graph

const ctrl = api.streamChat(
  { question: 'What is entanglement?' },
  {
    onSources: setSources,
    onToken: (t) => setAnswer((a) => a + t), // sources → token → done
    onDone: ({ execution_time_ms }) => {},
    onError: (e) => setError(e.message), // ApiClientError
  },
);
// ctrl.close() to cancel (e.g. on unmount)
```

See **[docs/packages/frontend.md](../../docs/packages/frontend.md)** for the full
client reference (every method and wire type, the SSE protocol, the error model,
the UI components, the build/test strategy, and the security model).

## See also

- [docs/packages/frontend.md](../../docs/packages/frontend.md) — full frontend reference.
- [docs/packages/backend.md](../../docs/packages/backend.md) — the `/api/v1` contract this client targets.
- [docs/monorepo.md](../../docs/monorepo.md) — workspace layout and conventions.
