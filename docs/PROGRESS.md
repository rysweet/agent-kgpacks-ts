# Execution Progress

Tracks the TypeScript port against [PLAN.md](./PLAN.md).

## Spikes (de-risking) — all validated

- **Spike A** (LadybugDB vector read via `@ladybugdb/core`): ✅ passes in CI (`@kgpacks/db` Spike A test).
- **Spike B** (BGE embedding parity): ✅ Transformers.js `Xenova/bge-base-en-v1.5` + CLS pooling = cosine 1.0 vs Python (gated by `@kgpacks/embeddings` parity test).
- **Spike D** (cross-encoder `ms-marco-MiniLM-L-12-v2` ONNX): ✅ exact match vs Python.
- **Spike C** (Copilot SDK throughput): pending formal bench; `@github/copilot-sdk@1.0.3` confirmed installable and used by `@kgpacks/agent`.

## Phase 0 — Foundations: DONE

- pnpm monorepo (Node 22, strict ESM), CI (build + **python-free guard**), 9 package skeletons.
- Parity harness (`@kgpacks/parity`): stage-localizing diff + dev-only Python oracle.

## Phase 1 — Runtime packages

| Package                         | Status                                           | Tests (CI) |
| ------------------------------- | ------------------------------------------------ | ---------- |
| `@kgpacks/db`                   | ✅ done                                          | 11         |
| `@kgpacks/embeddings`           | ✅ done (Spike B parity gate)                    | 11         |
| `@kgpacks/agent`                | ✅ done (Copilot SDK, structural parity)         | 60         |
| `@kgpacks/packs`                | ✅ done (incl. zip-slip security parity)         | 93         |
| `@kgpacks/query` (core)         | ✅ done (vector+hybrid retrieval, cypher-safety) | 51         |
| `@kgpacks/query` (enhancements) | ⏳ next                                          | —          |
| `@kgpacks/backend`              | ⏳ skeleton                                      | —          |
| `@kgpacks/mcp`                  | ✅ done (3-tool stdio server, schema-locked)     | 28         |
| `@kgpacks/cli`                  | ⏳ skeleton                                      | —          |
| `@kgpacks/eval`                 | ⏳ skeleton                                      | —          |

## Phase 2 (ingestion) / Phase 3 (cutover): not started
