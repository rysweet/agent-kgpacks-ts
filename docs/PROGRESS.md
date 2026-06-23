# Execution Progress

The TypeScript port of agent-kgpacks is **functionally complete end-to-end**.

## De-risking spikes — validated
- **A** LadybugDB vector read (`@ladybugdb/core`) — passes in CI (`@kgpacks/db` Spike A).
- **B** BGE embedding parity — Transformers.js `Xenova/bge-base-en-v1.5` (CLS pooling) =
  cosine 1.0 vs Python; gated by `@kgpacks/embeddings`.
- **D** cross-encoder `ms-marco-MiniLM-L-12-v2` ONNX — exact match vs Python.
- **C** Copilot SDK — `@github/copilot-sdk@1.0.3` integrated in `@kgpacks/agent`.

## Phase 0 — Foundations ✅
pnpm monorepo (Node 22, strict ESM), CI with **python-free guard**, parity harness
(`@kgpacks/parity`: stage-diff + dev-only Python oracle).

## Phase 1 — Runtime ✅ (all merged, green CI)
| Package | Tests | Notes |
|---|---|---|
| `@kgpacks/db` | 11 | LadybugDB wrapper; Spike A vector test |
| `@kgpacks/embeddings` | 11 | BGE; cosine-parity gate |
| `@kgpacks/agent` | 60 | Copilot SDK transport (BYOK), structural parity |
| `@kgpacks/packs` | 93 | manifest/installer/registry; zip-slip security |
| `@kgpacks/query` | 105 | vector+hybrid retrieval, reranker, cross-encoder, multi-doc, few-shot, cypher-RAG, cypher-safety |
| `@kgpacks/mcp` | 28 | stdio MCP server, 3 tools, schema-contract snapshots |
| `@kgpacks/backend` | 50 | Fastify + SSE; chat/search/graph/hybrid/articles; rate limit |
| `@kgpacks/cli` | 108 | `wikigr` runtime + ingestion subcommands |
| `@kgpacks/eval` | 56 | runner + LLM judge + baselines + stratified sampling |
| `apps/frontend` | 32 | Vite + React 18 SPA, typed `/api/v1` client, SSE chat |

## Phase 2 — Ingestion ✅
`@kgpacks/ingestion` (77 tests): Wikipedia/web sources, SSRF-safe fetcher
(per-hop validation), Copilot-SDK extraction, document-mode BGE embeddings,
LadybugDB schema + loader with HNSW vector index + FTS, bounded expansion,
`buildPack()`. Wired into the CLI (`create`/`update`/`research-sources`/`pack eval`).

## Phase 3 — Deploy ✅ / Cutover (operational)
- ✅ Multi-stage **Dockerfile** (glibc base), docker-compose, `docs/deployment.md`,
  and a CI **docker-image** job (build + no-Python + non-root).
- **Operational follow-ups (gated, not code):**
  - Consolidate the original 68 per-domain build scripts into the data-driven CLI.
  - Rebuild the 48-pack catalog with the TS pipeline and run the full
    2,716-question eval to confirm ≤2pp parity (requires LLM budget + network).
  - Decommission the Python repo after a shadow/canary window (manual decision).

> ~700 unit/integration tests pass in CI across the workspace.
