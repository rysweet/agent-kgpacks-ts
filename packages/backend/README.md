# @kgpacks/backend

The strict-ESM **HTTP server** of the agent-kgpacks TypeScript port: a
[Fastify](https://fastify.dev) application that serves the knowledge-graph query
API over `/api/v1` — **chat** (blocking `POST` and a Server-Sent-Events stream),
**semantic search**, **graph neighborhood**, **hybrid search**, and **article
detail** — plus the supporting `autocomplete`, `categories`, `stats`, and
`health` endpoints. It is a 1:1 port of the Python FastAPI backend
([`rysweet/agent-kgpacks/backend/`](https://github.com/rysweet/agent-kgpacks))
and **preserves the exact route contract and JSON response shapes** so the
existing frontend stays drop-in compatible.

> **Status: Phase 1 — implemented.** This README and
> [docs/packages/backend.md](../../docs/packages/backend.md) describe the shipped
> API. The server, all `/api/v1` routes, the SSE stream, the per-request
> connection manager, and per-route rate limiting are live and covered by offline
> Vitest suites (route shape/status, SSE framing, rate-limit, and contract
> snapshots). See [docs/PLAN.md](../../docs/PLAN.md) for the port plan and
> [docs/monorepo.md](../../docs/monorepo.md) for workspace conventions.

It builds on the merged retrieval stack — [`@kgpacks/db`](../db),
[`@kgpacks/query`](../query), [`@kgpacks/agent`](../agent), and
[`@kgpacks/embeddings`](../embeddings) — and contains **no Python** at runtime.

## Architecture at a glance

```
HTTP request ─▶ Fastify ─▶ rate-limit ─▶ JSON-schema validation
                              │
                              ▼
                     per-request LadybugDB Connection   (one in-flight query each;
                              │                            Spike-A concurrency rule)
                              ▼
        ┌──────────────┬───────────────┬──────────────┬───────────────┐
     search-service  graph-service  article-service  chat-service
     (direct Cypher) (direct Cypher) (direct Cypher) (@kgpacks/query
                                                       retrieval +
                                                       @kgpacks/agent
                                                       synthesis)
                              │
                              ▼
                  frozen JSON response shape  /  SSE frames  /  error envelope
```

- **One LadybugDB connection per request**, opened on entry and closed in a
  `finally`/`onResponse` hook. LadybugDB connections are **not** safe for
  concurrent in-flight queries (Spike A), so connections are never shared. The
  SSE route holds a **long-lived** connection for the lifetime of the stream and
  closes it once synthesis settles.
- **`search`, `graph`, `articles`, and `hybrid-search` use direct Cypher**
  (ported verbatim from the Python services). **`chat`** uses `@kgpacks/query`
  for retrieval and `@kgpacks/agent` for answer synthesis.
- **Every failure** returns the same envelope: `{ error: { code, message },
timestamp }`.

## Quick start

```ts
import { Database } from '@kgpacks/db';
import { CopilotAgent } from '@kgpacks/agent';
import { buildServer } from '@kgpacks/backend';

const database = new Database('pack.lbug');
const agent = new CopilotAgent(); // BYOK provider + pinned model from env
await agent.start();

const app = await buildServer({ database, agent });
await app.listen({ host: '127.0.0.1', port: 8000 });
// → GET http://127.0.0.1:8000/api/v1/search?query=quantum%20entanglement
```

Or run the bundled binary, which reads configuration from the environment:

```bash
WIKIGR_DATABASE_PATH=./pack.lbug WIKIGR_PORT=8000 node packages/backend/dist/index.js
```

The async `buildServer({ database, agent?, embedder?, rateLimit?, config?, logger? })`
seam injects its dependencies, so tests and embeddings run **fully offline** against
fakes while production wires the real database and Copilot agent. See
[docs/packages/backend.md](../../docs/packages/backend.md) for the full HTTP API
reference, SSE tutorial, configuration table, error model, and testing strategy.

## Endpoints

| Method | Path                      | Purpose                                          | Rate limit |
| ------ | ------------------------- | ------------------------------------------------ | ---------- |
| `POST` | `/api/v1/chat`            | Ask a question; blocking JSON answer             | 5/min      |
| `GET`  | `/api/v1/chat/stream`     | Same, streamed as SSE (`sources → token → done`) | 5/min      |
| `GET`  | `/api/v1/search`          | Semantic (vector) article search                 | 10/min     |
| `GET`  | `/api/v1/hybrid-search`   | Vector + graph-proximity search                  | 10/min     |
| `GET`  | `/api/v1/graph`           | Article graph neighborhood                       | 20/min     |
| `GET`  | `/api/v1/articles/:title` | Full article detail                              | 30/min     |
| `GET`  | `/api/v1/autocomplete`    | Title prefix/contains suggestions                | 60/min     |
| `GET`  | `/api/v1/categories`      | Category counts                                  | 30/min     |
| `GET`  | `/api/v1/stats`           | Corpus statistics                                | 30/min     |
| `GET`  | `/health`                 | Liveness + DB reachability                       | none       |

## Develop

```bash
pnpm --filter @kgpacks/backend build      # tsc -b (composite project refs)
pnpm --filter @kgpacks/backend test       # vitest (offline)
pnpm --filter @kgpacks/backend typecheck
```
