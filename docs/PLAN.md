# agent-kgpacks → TypeScript Port (End-to-End)

## Problem & Goal
Port the `agent-kgpacks` system (a knowledge-pack platform: build domain knowledge
graphs from docs, store them in LadybugDB with vector + FTS indexes, and answer
questions via a graph-RAG agent) from Python (~38.5K non-test LOC) to TypeScript.
The existing React/Vite frontend stays. Target a complete, e2e TS implementation.

## Confirmed Decisions
- **Sequencing:** *Phased* — port the **runtime** first (query/agent/backend/CLI/MCP),
  then the **ingestion/build pipeline** in a later phase.
- **Agent/LLM:** all agent interactions use the **GitHub Copilot SDK**
  (`@github/copilot-sdk`), replacing the Anthropic SDK. **Default: BYOK the same model**
  the Python system used for synthesis/expansion, so the SDK changes transport only, not
  model behavior (keeps eval parity achievable; see Acceptance Criteria).
- **Repo strategy:** a **fresh TypeScript repository**, ported **module-by-module
  with parity tests** against the current Python repo as the reference oracle.
- **Embeddings:** query-time embeddings via **Transformers.js (ONNX) BGE-base-en-v1.5**,
  validated for **retrieval/ranking parity** (identical top-k), tolerating tiny
  numeric differences. If parity fails, re-embed packs with the TS embedder
  (TS becomes canonical) — **never** fall back to a Python embedder.

## Hard Constraint: No Python in the Shipped Artifact
Python is **allowed during development and CI** — notably as the **parity oracle** that
generates expected outputs. What is forbidden is a Python dependency in the **final
product's runtime, build, and deploy path**. Consequences that shape this plan:
- The Python repo is a **development-time oracle**. It may run in CI to (re)generate or
  re-verify parity fixtures. It must **not** be importable or invokable by the shipped
  runtime, the production build, or the deploy image.
- Keep the oracle behind a clearly separated dev-only boundary (e.g. a `parity/` job /
  package) so a Python dependency can never silently leak into a runtime package's
  dependency graph. Enforce with a CI check that the runtime packages and the production
  image contain no Python.
- Reading existing packs from Node is **not** a Python dependency: a LadybugDB file is a
  data artifact read by a C++ engine via `@ladybugdb/core`. Stored vectors are just
  floats; the only Python-derived behavior the runtime must reproduce is the **query
  embedder** (hence the parity gate below).
- No "keep the Python builder running in production" option. The TS ingestion pipeline
  (Phase 2) must reach feature/quality parity before the old builder is retired; there
  is no runtime fallback to it.

## Acceptance Criteria — Definition of Done
"Parity" is meaningless unless measured. The port is **done** when all hold:
- **Eval quality:** TS runtime scores **within 2 percentage points** of the frozen
  Python baseline on the existing eval set (48 packs / 2,716 questions). Any pack
  regressing >5pp is a blocker. Baseline is frozen once, up front.
  - **Hold the judge constant.** The baseline was judged by Claude Opus; the TS run must
    use the **same judge model and same judge prompt**, or judge variance will swamp the
    2pp bar. The judge is pinned and identical on both sides (route it via Copilot SDK
    BYOK to that exact model, or keep a fixed external judge — but identical).
  - **Hold the synthesis model constant.** Use the Copilot SDK as *transport* but **BYOK
    the same model** the Python system used for synthesis/expansion. This is what makes
    "use the Copilot SDK" and "match quality" compatible: only the plumbing changes, not
    the model. If a different model is later desired, re-baseline first.
  - **Cost control:** full 2,716-question eval is a gated/periodic run; use a **stratified
    sample** (a few questions per pack) for routine development to bound API spend/quota.
- **Retrieval parity:** for the fixed query set, TS returns the **same top-k node IDs in
  the same order** as the frozen Python oracle on the fixture pack (vector + hybrid).
- **Contract parity:** MCP tool schemas and CLI command/flag surface are byte-compatible
  with the Python originals (see External Contracts below), or breakage is explicitly
  signed off.
- **Security parity:** every ported validator passes the original Python test vectors
  plus added negative tests (see Security Parity below).
- **Ships Python-free:** CI proves the runtime packages and the production image contain
  no Python (see Hard Constraint).
- **No open Sev-1/Sev-2** behavioral diffs vs the Python system on the smoke + e2e suite.

## Reality Check — This Is Big-Bang Delivery
The chosen strategy (fresh repo, cut over at the end) means **no user-facing value ships
until Phase 3**. That is the accepted trade for a clean codebase. Consequences:
- Keep the **Python system running in production** until cutover (dev/ops use of Python is
  allowed; it is simply not the *shipped TS artifact's* dependency).
- The **walking skeleton** (Phase 0) and per-module demos are the only evidence of
  progress before cutover — treat them as mandatory checkpoints, not nice-to-haves.
- A long-lived branch/repo with no integration to prod accumulates drift. Ideally
  **freeze net-new feature work** on the Python system during the port. If a freeze isn't
  organizationally realistic, enforce **change-log discipline**: every new Python behavior
  is mirrored into the TS backlog, and accept that the parity target is moving (and the
  baseline must be re-frozen when it does).

## Validated Facts (from investigation)
- LadybugDB = rebranded Kùzu. Official Node/TS binding: **`@ladybugdb/core`** (npm),
  TS types included, prebuilt binaries for darwin/linux/win × x64/arm64, ESM+CJS.
- **Storage compatibility proven:** Node `@ladybugdb/core` 0.17.1 (storage v41) reads
  Python `real_ladybug` 0.15.3 (storage v40) DBs, including `LOAD EXTENSION VECTOR/FTS`
  and `QUERY_VECTOR_INDEX` over Python-built HNSW indexes → existing packs are
  readable from Node with **no rebuild/migration**.
- Node binding also has matching `0.15.x` builds if exact storage parity is preferred.
- BGE + `cross-encoder/ms-marco-MiniLM` are available via Transformers.js (ONNX).

## Default Stack (flagged; adjustable)
- **Runtime:** Node 22 LTS, TypeScript strict, **ESM**.
- **Monorepo:** pnpm workspaces. Packages:
  - `@kgpacks/db` — LadybugDB wrapper over `@ladybugdb/core` (connection mgmt, params, Cypher helpers, extension loading).
  - `@kgpacks/embeddings` — Transformers.js BGE (query embed, with BGE query prefix) + cross-encoder reranker.
  - `@kgpacks/agent` — Copilot SDK client/session mgmt; synthesis, query-expansion, multi-query, seed-article ID.
  - `@kgpacks/query` — retrieval pipeline: vector search, graph reranker, multi-doc synthesis, few-shot, cross-encoder, cypher-RAG, cypher safety validation.
  - `@kgpacks/packs` — manifest model, installer, validator, registry, distribution (tar.gz), versioning.
  - `@kgpacks/backend` — Fastify + SSE (replaces FastAPI); endpoints: chat (POST + GET stream), search, graph, hybrid, articles; rate limiting.
  - `@kgpacks/cli` — commander/yargs; query + pack subcommands (ingestion subcommands land in Phase 2).
  - `@kgpacks/mcp` — TS MCP SDK; tools: list_packs, pack_info, query_knowledge_pack.
  - `@kgpacks/eval` — eval runner + judge (Copilot SDK), baselines, skill evaluators.
  - `@kgpacks/ingestion` *(Phase 2)* — sources (wikipedia/web), LLM extraction, write-side embeddings, expansion, schema, DB loader.
  - `frontend` — migrate existing React/Vite app as-is; point API client at the Fastify backend.
- **Test:** vitest. **Parity harness** in `tools/parity` consuming golden fixtures
  exported from the Python repo.

## Parity Methodology (the backbone of the port)
1. **Python is the dev-time oracle.** Run the Python repo (in dev or a dedicated CI job)
   to export **golden fixtures** per module: inputs + outputs (query → BGE query vector;
   query → retrieved node IDs/order; reranked order; cross-encoder scores; cypher-RAG
   generated Cypher; manifest parsing; pack validation verdicts; eval scores). Fixtures
   are committed artifacts the TS suite reads. The oracle lives in a dev-only boundary
   and must never leak into a runtime package's dependency graph (CI-enforced).
2. **Port the existing Python tests as a second oracle.** The repo has ~73 test files
   encoding behavior. Translate them to vitest alongside the I/O fixtures — they capture
   edge cases that a handful of frozen inputs will miss. Where a Python test asserts an
   exact value, port the assertion; where it exercises randomness/LLMs, port the
   structure. Frozen I/O fixtures + ported tests together are the spec.
3. **Fixtures must be regenerable and provenance-stamped.** A `parity/` package holds the
   exporter, a **pinned Python env** (lockfile), and pinned model versions; each fixture
   file records the git SHA, model IDs, and binding/storage version that produced it.
   "Committed and forgotten" fixtures rot — regeneration must be one command.
4. **Determinism caveats (state honestly):**
   - Read-side retrieval parity is tested against a **frozen prebuilt DB** (the index is
     fixed), so top-k ordering is reproducible.
   - HNSW index *construction* and torch embeddings are **not** bit-reproducible across
     threads/hardware; therefore **write-side** (Phase 2) parity is judged by **eval
     quality**, never by byte/index equality.
   - Embedding parity uses cosine ≥ ~0.999, not exact equality.
5. **Fixture pack — keep it tiny, synthetic, and license-clean.** Do **not** commit a
   built DB of scraped Wikipedia/web docs (CC BY-SA / copyright + repo bloat). Build the
   fixture pack from a **small, synthetic or public-domain** source set, keep it to a few
   nodes, and store the binary DB via **Git LFS** (or a fixtures bucket), not plain git.
   Rebuild it when the binding/storage version changes.
6. For deterministic layers (embeddings, vector/FTS retrieval, graph reranker, manifest,
   validation): assert **exact or near-exact parity** against frozen outputs.
7. For LLM-dependent steps (synthesis/expansion/extraction): the provider changes
   (Copilot SDK), so exact parity is impossible. Assert **structural parity** only —
   valid JSON shape, seed-title set overlap, citation presence, retrieved top-k identity.
   Be honest that parity gives **high confidence on the retrieval stack and low
   confidence on the agent stack**; cover the agent stack with behavioral/eval tests.
8. Each TS module ships only when its parity suite passes.
9. **Stage-localizing diff tool.** When a pack regresses, end-to-end scores don't tell you
   *which* stage broke. Provide a parity diff that compares per-stage outputs (query
   embedding → retrieved IDs → reranked IDs → synthesized answer) against the oracle so a
   regression is pinned to retrieval vs reranking vs synthesis, not guessed.

## External Contracts (must not break silently)
These are consumed by third parties and are part of Definition of Done:
- **MCP tools** (`list_packs`, `pack_info`, `query_knowledge_pack`): preserve tool names,
  argument names/types, and result shape. The Python `mcp_server.py` docstring documents
  VS Code / Claude Desktop configs — the TS server must be a drop-in (same stdio
  transport, same tool schemas). Snapshot-test the tool schemas against the Python server.
- **CLI** (`wikigr` + subcommands `query/status/pack {install,list,info,validate,remove}`
  and Phase-2 ingestion commands): preserve command names, flags, and exit codes; port
  the CLI help/usage as golden snapshots. If the binary is renamed, alias the old name.
- **Backend HTTP API** (`/api/v1/*`): preserve routes, query params, response JSON shapes,
  and SSE event framing for the existing frontend; snapshot responses against Python.
- **Pack on-disk format / manifest schema:** unchanged (existing packs must keep working).

## Security Parity (port deliberately, test adversarially)
Hand-porting security checks is a classic place to introduce vulnerabilities. Treat these
as first-class, with negative tests:
- **Cypher injection:** port `_validate_cypher` and the read-only/allowed-statement rules;
  carry over the Python test vectors and add injection attempts that must be rejected.
- **Pack name / path safety:** port `PACK_NAME_RE` exactly; reject traversal and odd
  unicode.
- **Archive extraction (zip-slip / tar path traversal):** the installer extracts
  `.tar.gz`; add explicit tests for entries escaping the target dir, symlinks, and
  absolute paths. Validate before write.
- **URL allow-listing / SSRF** on pack install-from-URL and source fetching: port the
  HTTPS-only and host validation; add negative tests.
- **Rate limiting** (backend): preserve limits/behavior; test the limiter, not just happy
  paths.

## Phases & Workstreams

### Phase 0 — Foundations & Go/No-Go Spikes
Each spike below has an explicit **kill criterion**. If one fails, the architecture
changes *before* Phase 1, not after.
- Scaffold pnpm monorepo, tsconfig (strict, ESM), eslint/prettier, vitest, CI.
- Pin `@ladybugdb/core` (decide 0.17.x latest vs 0.15.x exact-parity) + lockfile.
- **Spike A — DB read + concurrency:** open a real existing pack DB from Node; run vector
  + FTS + graph queries. **Also settle the concurrency model now:** the Python backend
  used a per-request `Connection` + a thread pool because connections aren't thread-safe.
  Determine whether `@ladybugdb/core` supports concurrent async queries on one
  `Connection`, or whether the backend needs a **connection pool / worker_threads**.
  *Kill: cannot reproduce a known query's results.* (Read path already de-risked;
  concurrency is the open question.)
- **Spike B — Embedding pooling parity (highest sleeper risk):** ✅ **PASS (validated
  2026-06-23, cosine = 1.000000).** Transformers.js `Xenova/bge-base-en-v1.5` (ONNX) with
  **`pooling: 'cls'`** reproduces the Python sentence-transformers `BAAI/bge-base-en-v1.5`
  vectors exactly for both documents (no prefix) and queries (with the BGE query prefix).
  Correction to an earlier assumption: the sentence-transformers output **is L2-normalized**
  (a `Normalize` module in the model's `modules.json` → `‖v‖ = 1.0`), so the TS embedder
  should set `pooling:'cls'` and **normalize** for byte-level stored-vector parity. (Cosine
  / HNSW-cosine is scale-invariant, so retrieval parity holds even if normalization is
  skipped — but match it anyway.) *Residual kill criterion retired.*
- **Spike C — Copilot SDK throughput/cost/latency:** the SDK drives the Copilot CLI as
  a subprocess (JSON-RPC), not a raw HTTP completion API. Measure latency, max
  concurrency, failure modes, and cost for the actual call shapes (synthesis +
  expansion). **The SDK is a fixed product mandate, so this spike does not decide
  *whether* to use it — it decides *how*.** If interactive latency or batch throughput
  is inadequate, the response is an **architecture change, not a dependency swap**:
  (a) a session pool with bounded concurrency, (b) an async job queue for batch
  extraction (Phase 2), (c) request coalescing/caching for expansion, and/or (d) BYOK
  routing within the SDK. *Kill criterion here means "escalate to the mandate owner with
  measured numbers," not "silently switch to Anthropic."*
- **Spike D — cross-encoder ONNX:** ✅ **PASS (validated 2026-06-23, exact match).**
  `Xenova/ms-marco-MiniLM-L-12-v2` ships full ONNX builds (fp32 + quantized);
  Transformers.js (`AutoModelForSequenceClassification`, fp32) reproduces the Python
  `cross-encoder/ms-marco-MiniLM-L-12-v2` logits **identically** (max |diff| = 0.0000,
  same ranking). No L-6 fallback required.
- **Walking skeleton:** stand up the thinnest end-to-end vertical slice — open fixture
  pack → embed query (TS) → vector search → Copilot-SDK synthesis → return answer —
  wired through a trivial backend route. This proves the seams between the four risky
  dependencies **before** breadth work begins.
- Build the parity harness + fixture exporter (Python dev-time oracle).

### Phase 1 — Runtime (port order, each gated by parity)
1. `@kgpacks/db` — connection manager, param binding, extension load, Cypher exec.
2. `@kgpacks/embeddings` — BGE query embeddings (Transformers.js/ONNX); **retrieval
   parity** vs Python on the fixture pack (same top-k for a query set).
3. `@kgpacks/query` core — vector retrieval + cypher safety validation.
4. `@kgpacks/query` enhancements — graph reranker, multi-doc synthesis, few-shot
   (BGE example similarity), optional cross-encoder rerank.
5. `@kgpacks/agent` — Copilot SDK: synthesis, query-expansion/multi-query,
   seed-article identification; token/usage accounting equivalent of `_track_response`.
6. `@kgpacks/packs` — manifest parse/validate, installer (tar.gz extract → skills dir),
   registry, versioning, distribution. (Read/install/validate; create stays Phase 2.)
7. `@kgpacks/backend` — Fastify port of chat (incl. SSE stream), search, graph,
   hybrid, articles; rate limiting; shared DB connection manager.
8. `@kgpacks/mcp` — MCP server with the 3 tools.
9. `@kgpacks/cli` — `query`, `status`, and `pack {install,list,info,validate,remove}`.
10. `frontend` — migrate app, point at Fastify; e2e smoke (Playwright) against backend.
11. `@kgpacks/eval` (read-side) — run existing packs through eval; compare scores.

### Phase 2 — Ingestion / Build pipeline
**Port behavior first; do not redesign mid-port.** Replicate the existing pipeline's
behavior in TS before any restructuring.
- `@kgpacks/ingestion`: sources (Wikipedia + generic web fetch/clean), LLM entity
  & relationship extraction (Copilot SDK), **write-side** BGE + chunk embeddings,
  graph expansion/link discovery/work queue, schema creation, DB loader,
  `CREATE_VECTOR_INDEX`/FTS.
- **Write-side embedding parity:** the builder must produce vectors consistent with the
  query embedder validated in Spike B — Transformers.js `Xenova/bge-base-en-v1.5`,
  `pooling:'cls'`, L2-normalized, **no** query prefix for documents (prefix is query-only).
- **Storage-write version:** decide DB write version; if Node writes v41 while the old
  Python builder read v40, treat the builder swap as a **one-way cutover** (Node becomes
  the only builder). Re-build the catalog with the TS pipeline; gate on **eval parity**
  vs current published packs.
- **Script consolidation is a SEPARATE, LATER task.** The 68 `build_*_pack` scripts are
  mostly config (a domain name + `urls.txt`). Port the shared builder behavior first and
  keep packs building; only then collapse the per-domain scripts into one data-driven
  builder. Combining a language port with a redesign is how ports miss deadlines and
  regress quietly.
- CLI ingestion subcommands: `create`, `update`, `research-sources`, `pack create/eval/update`.

### Phase 3 — Cutover & Decommission
- Full feature-parity sign-off (parity suites + e2e + Acceptance Criteria met).
- **Safe cutover, not a flag-flip:** run the TS system in **shadow/canary** against real
  traffic first (compare answers/latency to Python), then ramp. Keep the **Python system
  deployable for a defined rollback window** (e.g. a few weeks) before decommissioning;
  do not delete it until the window passes clean.
- Port docs (mkdocs → chosen TS docs), Dockerfile (glibc base, not Alpine, or add
  build toolchain), Makefile equivalents, packaging/release.
- Deprecate the Python repo (redirect to the new TS repo) **after** the rollback window.

## Critical Path & Parallelism (relative sizing, not calendar dates)
- **Critical path:** Phase 0 spikes → `@kgpacks/db` → `@kgpacks/embeddings` → `@kgpacks/query`
  core → `@kgpacks/agent` → `@kgpacks/backend` → cutover. Everything else hangs off these.
- **Parallelizable once `db` + `query` core land:** `packs`, `mcp`, `cli`, and the
  `frontend` migration are largely independent and can proceed concurrently.
- **Largest single effort:** Phase 2 ingestion (LLM extraction + write-side embeddings +
  expansion). Do not start it until Phase 1 retrieval/agent parity is proven — it reuses
  both.
- **Smallest real risk:** the frontend (already TypeScript; mostly an API-client retarget).
- Sequence by **risk burndown**: the four spikes and the walking skeleton must complete
  before any breadth work, because they can each invalidate the architecture.

## Key Risks & Mitigations
- **Embedding pooling/normalization** (Spike B — RESOLVED ✅): stored vectors are
  **CLS-pooled and L2-normalized**; Transformers.js `Xenova/bge-base-en-v1.5` with
  `pooling:'cls'` (+ normalize) reproduces them at cosine 1.0. Use that config in the TS
  embedder. The shipped artifact stays Python-free; no runtime Python embedding service.
- **Copilot SDK is an agentic CLI-subprocess runtime**, not a raw completion API:
  heavier concurrency/latency, esp. for batch extraction (Phase 2). Mitigate with a
  session pool + concurrency limits; validate in Spike C with a kill criterion.
- **Storage write-version skew** (Phase 2): Node may write v41; treat the builder cutover
  as one-way. Until the TS builder + eval parity are proven, keep building packs with the
  Python builder **in development only** (never shipped).
- **Native binary / deploy**: no Alpine/musl prebuild for `@ladybugdb/core` → use a glibc
  base image (e.g. `node:22-bookworm-slim`) or a source-build toolchain (CMake/C++20 —
  and note that source-build path itself wants Python, so prefer prebuilt + glibc to keep
  images Python-free). Extension `INSTALL` needs network → pre-stage for air-gapped.
- **`@ladybugdb/core` maturity is the biggest external bet** (months-old binding, daily
  dev builds, recently renamed from Kuzu). Mitigations: **pin an exact version + lockfile
  + vendor the prebuilt binaries** into an internal registry/artifact store; track
  upstream issues; keep a **contingency path** since it's MIT — either (a) the LadybugDB
  **Wasm** binding, (b) building the native addon from pinned source, or (c) upstreaming a
  fix. Validate a real query workload against the pinned version in Spike A and don't
  float the version mid-port.
- **LLM cost / quota** for re-judging 2,716 questions and (Phase 2) rebuilding 48 packs
  via the SDK is non-trivial. Mitigate with stratified-sample evals during development,
  full evals only at gates, response caching for expansion, and an explicit budget/quota
  check before Phase 2 batch runs.
- **`apache-arrow` transitive weight**: `@ladybugdb/core` depends on Arrow; account for
  bundle size/cold-start and pin it.
- **cross-encoder L-12 ONNX** (Spike D — RESOLVED ✅): `Xenova/ms-marco-MiniLM-L-12-v2`
  exists with ONNX builds and matches the Python cross-encoder exactly (fp32). Use it
  directly; L-6 fallback unnecessary.

## COE Review — Sharp Edges & Adjustments
**Review status: PASS after 3 rounds** (proxy COE review). The plan is defensible.
Residual items are team decisions, not gaps — see Open Decisions. The bar to keep it
green: the parity oracle, the four kill-criteria spikes, and the measured Acceptance
Criteria must stay real, not aspirational.

What this actually is: a **full rewrite across a language boundary plus three immature/
heavy external dependencies** (Copilot SDK, a Node native graph-DB binding, ONNX
embeddings), not a "port." Treat it accordingly.
- **Rewrites lose hard-won behavior.** The risk isn't writing TS; it's silently dropping
  the hundreds of edge-case fixes embedded in 38.5K LOC. The parity oracle is the single
  most important asset here — it is what separates this from a typical doomed rewrite.
  Invest in it first and keep it green.
- **Sequence by risk, not by layer.** The walking skeleton (Phase 0) must exercise all
  four risky seams before breadth work. Most rewrite pain comes from discovering an
  integration wall at 70% done.
- **Don't bundle a redesign with the port.** Defer the 68-script consolidation. One
  variable at a time: change the language, keep the behavior; refactor later.
- **The agent stack will never have exact parity.** Different provider/model. Be explicit
  that retrieval parity is high-confidence and answer parity is not; lean on eval scores,
  not vibes.
- **"E2E" includes the unglamorous tail.** Rate limiting, SSE backpressure, DB connection
  lifecycle/threading, cypher-injection validation, tar.gz pack install safety, error
  taxonomies. These are where ports regress; they need their own parity fixtures.

## Open Decisions (resolve before/at Phase 0)
- Pin Node binding to **0.15.x (exact storage parity)** or **0.17.x (validated
  forward-read)**? Recommend 0.15.x during the port to remove a variable, bump later.
- Backend framework: **Fastify** (assumed) vs NestJS — pick based on team familiarity.
- Monorepo tool: **pnpm workspaces** (assumed) vs Nx/Turborepo for caching at this size.

## Out of Scope (initially)
- Browser/Wasm runtime (LadybugDB has a Wasm binding; revisit later).
- Rewriting pack content/format; pack on-disk layout stays compatible.
