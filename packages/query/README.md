# @kgpacks/query

Retrieval pipeline for the agent-kgpacks TypeScript port (Phase 1). The **CORE**
slice — vector search, hybrid (vector + graph + keyword) retrieval, and read-only
Cypher safety validation — is documented below. The **ENHANCEMENTS** slice —
graph reranker, cross-encoder reranking, multi-document synthesis, few-shot
selection, and Cypher-RAG — builds on top of CORE as five optional, opt-in stages;
see [docs/enhancements.md](docs/enhancements.md). Ported from the upstream
`wikigr/agent` read path
([rysweet/agent-kgpacks](https://github.com/rysweet/agent-kgpacks)).

> The enhancements stages are **off by default**: with no `enable*` flags set,
> `retrieve()` is byte-for-byte identical to the CORE pipeline described here. See
> [docs/enhancements.md](docs/enhancements.md) and [docs/PLAN.md](../../docs/PLAN.md).

## Usage

```ts
import { Database } from '@kgpacks/db';
import { createRetriever } from '@kgpacks/query';

const db = new Database('pack.kuzu');
const conn = db.connect();
await conn.loadExtension('vector');

const retriever = createRetriever(conn);

// Vector retrieval (default): top-k nodes ranked by cosine similarity.
const hits = await retriever.retrieve('what is quantum entanglement?', { k: 5 });

// Hybrid retrieval: blends vector similarity, LINKS_TO graph proximity, and
// title keyword matches (weights default to 0.5 / 0.3 / 0.2).
const blended = await retriever.retrieve('quantum entanglement', {
  mode: 'hybrid',
  k: 5,
  weights: { vector: 0.5, graph: 0.3, keyword: 0.2 },
});
```

Each result is `{ id, score, content }`. For `vector` mode, `score` is cosine
similarity (`1 - distance`, clamped to `[0, 1]`); for `hybrid` mode it is the
weighted sum of the three signals.

### Schema

Retrieval expects a node table (default `Section`) with `id`, `content`, and
`title` columns plus an embedding column indexed under a cosine vector index
(default `embedding_idx`), and `LINKS_TO` edges between nodes for the graph
signal. Override the table/index names via `createRetriever(conn, { nodeTable,
vectorIndex })`.

## Enhancements (optional stages)

Five opt-in stages re-rank, augment, and synthesize over the CORE results. They
are **off by default** — supply per-query `enable*` flags to turn them on — and
share heavyweight resources (BGE embedder, cross-encoder, agent) constructed once
on the retriever:

```ts
import { CopilotAgent } from '@kgpacks/agent';
import { createRetriever } from '@kgpacks/query';

const agent = new CopilotAgent();
await agent.start();

const retriever = createRetriever(conn, { agent, fewShotExamples });

// Re-rank candidates (graph proximity + ms-marco cross-encoder).
const reranked = await retriever.retrieve('quantum entanglement', {
  k: 5,
  enableReranker: true,
  enableCrossEncoder: true,
});

// Full pipeline + a synthesized, cited answer.
const { results, synthesis } = await retriever.retrieveAndSynthesize('how does HNSW search work?', {
  enableCypherRag: true,
  enableReranker: true,
  enableCrossEncoder: true,
  enableFewshot: true,
  enableMultidoc: true,
});
```

| Flag                 | Stage                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| `enableCypherRag`    | Agent-generated Cypher → `validateCypher` (fail-closed) → merge rows. |
| `enableReranker`     | Deterministic `LINKS_TO` graph-proximity re-rank.                     |
| `enableCrossEncoder` | `Xenova/ms-marco-MiniLM-L-12-v2` (fp32) relevance re-score (Spike D). |
| `enableFewshot`      | Top-`n` BGE-cosine exemplar selection for the synthesis prompt.       |
| `enableMultidoc`     | Multi-document answer synthesis via `@kgpacks/agent`.                 |

With all flags unset, `retrieve()` is identical to the CORE pipeline. Full
contract, API reference, configuration, parity gate, and examples:
**[docs/enhancements.md](docs/enhancements.md)**.

## Cypher safety

`validateCypher(cypher)` enforces a read-only allow-list with strict parity to
the Python `_validate_cypher`. It **throws** `CypherValidationError` unless the
query:

1. starts with `MATCH` or `CALL` (after string literals are stripped);
2. contains no write/DDL keyword (`CREATE`, `DELETE`, `DROP`, `SET`, `MERGE`,
   `REMOVE`, `DETACH`) outside a string literal;
3. contains no variable-length path pattern (`[...*...]`).

```ts
import { validateCypher, CypherValidationError } from '@kgpacks/query';

validateCypher('MATCH (a:Article) RETURN a LIMIT 10'); // ok
validateCypher('MATCH (a) DELETE a'); // throws CypherValidationError
```

The CORE `retrieve` path never routes user text into Cypher (it runs fixed,
parameter-bound queries); `validateCypher` is exported for callers that build
Cypher from untrusted input.
