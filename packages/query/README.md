# @kgpacks/query

CORE retrieval pipeline for the agent-kgpacks TypeScript port (Phase 1): vector
search, hybrid (vector + graph + keyword) retrieval, and read-only Cypher safety
validation. Ported from the Python `wikigr/agent` read path
([rysweet/agent-kgpacks](https://github.com/rysweet/agent-kgpacks)).

> Reranker, multi-document synthesis, few-shot prompting, cross-encoder
> reranking, and Cypher-RAG are a later slice (query-enhancements) and are not
> implemented here. See [docs/PLAN.md](../../docs/PLAN.md).

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
