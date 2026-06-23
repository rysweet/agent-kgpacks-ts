# `@kgpacks/agent`

The LLM layer of the port: a strict-ESM wrapper around the **GitHub Copilot SDK**
([`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk)) that
provides the four agent operations the Python system exposed —
**answer synthesis**, **query expansion**, **multi-query generation**, and
**seed-article identification** — plus **token/usage accounting** equivalent to
the Python `_track_response`. The SDK changes _transport only_: per
[docs/PLAN.md](../PLAN.md) the same model is used via **BYOK**, so model behavior
(and therefore eval quality) is held constant.

> **Status: Phase 0 skeleton → this is the Phase 1 API design.** The package
> currently ships only a buildable placeholder (`PACKAGE_NAME`). This document is
> the **API contract** the Phase 1 implementation builds to; it is the agent
> analogue of [docs/packages/db.md](./db.md). No business logic exists yet.

> **The agent stack will never have exact parity** (different provider/model).
> Per [docs/PLAN.md](../PLAN.md) §"Parity Methodology" the contract guarantees
> **structural parity only** — valid JSON shape, seed-title set overlap, citation
> presence — and confidence in answer quality comes from **eval scores**, not
> byte-equality. Unlike the MCP/CLI/backend packages, the agent has **no
> external byte-compatible contract**.

## Dependency & pinning

- **Runtime dependency:** `@github/copilot-sdk` pinned to **`1.0.3`** (exact, no
  range — matching the repo's no-caret convention for third-party runtime deps,
  cf. `@ladybugdb/core` at `0.17.1`). The lockfile is committed. The SDK is an
  **agentic CLI-subprocess runtime** (JSON-RPC), not a raw HTTP completion API
  ([docs/PLAN.md](../PLAN.md) Spike C), so its version is **not floated**
  mid-port; bumps are deliberate and re-validated.
- **Module system:** native ESM. Import named exports directly; relative imports
  use the `.js` extension under `NodeNext`.
- **Scaffold-test impact (deliberate, signed-off):** `test/scaffold.test.ts`
  asserts that no package other than `db`/`embeddings` carries a third-party
  runtime dependency. Adding the SDK requires **minimally relaxing that one
  assertion** to exempt `@github/copilot-sdk` for `agent` — the same class of
  necessary exception already granted to `db` and `embeddings`. This is part of
  the implementation step's Definition of Done, not this design.

> **API stability caveat.** The SDK method/event names below
> (`CopilotClient.createSession`, `CopilotSession.sendAndWait`,
> `assistant.message` / `assistant.usage` events) are **verified against
> `@github/copilot-sdk@1.0.3`** at design time. The `CopilotAgent` surface is the
> _intended_ Phase 1 contract; the prompt strings and the exact mapping of SDK
> events to `Usage` fields are confirmed empirically during implementation and
> back-filled here if the runtime differs.

## Installation

`@kgpacks/agent` is an internal workspace package consumed by other `@kgpacks/*`
packages (notably `@kgpacks/query` and `@kgpacks/eval`) via a workspace
dependency:

```jsonc
// packages/<consumer>/package.json
{
  "dependencies": {
    "@kgpacks/agent": "workspace:*",
  },
}
```

From the repo root:

```bash
pnpm install
pnpm --filter @kgpacks/agent build
pnpm --filter @kgpacks/agent test   # offline — transport is mocked
```

## Quick start

```ts
import { CopilotAgent } from '@kgpacks/agent';

// BYOK the pinned synthesis model (default). Construct → start → use → stop.
const agent = new CopilotAgent();
await agent.start();

try {
  const { answer, metadata, usage } = await agent.synthesizeAnswer({
    question: 'How does HNSW indexing work?',
    context: [
      { id: 'doc:1', text: 'HNSW builds a navigable small-world graph…' },
      { id: 'doc:2', text: 'Search descends layers greedily…' },
    ],
  });

  console.log(answer); // synthesized, citation-bearing prose
  console.log(metadata.citedIds); // e.g. ['doc:1', 'doc:2']
  console.log(usage.totalTokens); // tokens spent on this call
} finally {
  await agent.stop();
}
```

Other operations follow the same lifecycle:

```ts
const expansions = await agent.expandQuery('vector db parity');
// → ['vector database parity', 'embedding retrieval equivalence', …]

const variants = await agent.multiQuery('how to install a pack', { count: 3 });
// → 3 paraphrased retrieval queries

const seeds = await agent.identifySeedArticles({
  topic: 'graph databases',
  candidates: ['Kùzu', 'HNSW', 'Cypher', 'Apache Arrow'],
});
// → string[] of selected titles (fence-stripped JSON array)

console.log(agent.getUsage()); // cumulative across every call this session
```

## API reference

### `class CopilotAgent`

Owns one Copilot SDK client + session for its lifetime and exposes the four LLM
operations plus usage accounting. All operations are **async** and **fail
closed** (see [Error handling](#error-handling)).

#### `new CopilotAgent(options?: CopilotAgentOptions)`

Constructs an agent. Cheap and side-effect-free: it creates **no** SDK client and
opens **no** session until [`start()`](#agentstart-promisevoid) is called.

| Field       | Type                    | Default                    | Description                                                                                                              |
| ----------- | ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `model`     | `string`                | `DEFAULT_SYNTHESIS_MODEL`  | BYOK model id used for **all** operations, held constant per run. Overriding it is a re-baseline event (see Versioning). |
| `transport` | `Transport`             | `createCopilotTransport()` | The injectable transport seam. Tests pass a mock so the suite runs **fully offline**.                                    |
| `providers` | `NamedProviderConfig[]` | _unset_                    | Optional BYOK provider routing passed through to `createSession({ providers })`.                                         |
| `timeoutMs` | `number`                | _SDK default_              | Default per-request timeout forwarded to `sendAndWait`. Overridable per call.                                            |

#### `agent.start(): Promise<void>`

Creates the SDK client, calls `client.start()`, and opens a session pinned to
`model`/`providers`. **Idempotent** — a second call resolves without opening a
second session. Throws [`AgentTransportError`](#error-handling) if the SDK fails
to start.

#### `agent.stop(): Promise<void>`

Disconnects the session (`session.disconnect()`) and stops the client
(`client.stop()`), releasing the subprocess. **Idempotent** and safe to call in a
`finally` block even if `start()` never succeeded. Any `Error[]` returned by the
SDK's `stop()` is surfaced as an `AgentTransportError` only when non-empty.

#### `agent.synthesizeAnswer(request: SynthesisRequest): Promise<SynthesisResult>`

Synthesizes a grounded, citation-bearing answer from retrieved context.

| Parameter | Type               | Description                                |
| --------- | ------------------ | ------------------------------------------ |
| `request` | `SynthesisRequest` | Question + retrieved context (see schema). |

Returns a [`SynthesisResult`](#synthesisresult). Throws
[`AgentResponseFormatError`](#error-handling) if the model returns empty content.

#### `agent.expandQuery(query: string, options?: ExpandQueryOptions): Promise<string[]>`

Expands one query into semantically related reformulations for broader retrieval.
Returns a **`string[]`** parsed from a fence-stripped JSON array; throws
`AgentResponseFormatError` if the response is not a JSON array of strings.

| Parameter           | Type     | Default      | Description                  |
| ------------------- | -------- | ------------ | ---------------------------- |
| `query`             | `string` | —            | The original user query.     |
| `options.count`     | `number` | `3`          | Target number of expansions. |
| `options.timeoutMs` | `number` | ctor default | Per-call timeout override.   |

#### `agent.multiQuery(query: string, options?: MultiQueryOptions): Promise<string[]>`

Generates multiple **paraphrased** retrieval queries for the same intent
(multi-query retrieval / RAG fusion). Same return/parse contract as
`expandQuery`.

| Parameter           | Type     | Default      | Description                       |
| ------------------- | -------- | ------------ | --------------------------------- |
| `query`             | `string` | —            | The original user query.          |
| `options.count`     | `number` | `3`          | Number of query variants to emit. |
| `options.timeoutMs` | `number` | ctor default | Per-call timeout override.        |

#### `agent.identifySeedArticles(request: SeedArticleRequest): Promise<string[]>`

Selects the most relevant seed-article titles for a topic from a candidate set.
Returns a **`string[]`** of selected titles parsed from a fence-stripped JSON
array. Parity is judged by **seed-title set overlap** with the Python oracle, not
exact equality.

| Parameter            | Type       | Default | Description                                    |
| -------------------- | ---------- | ------- | ---------------------------------------------- |
| `request.topic`      | `string`   | —       | The domain/topic to find seeds for.            |
| `request.candidates` | `string[]` | —       | Candidate article titles to choose from.       |
| `request.limit`      | `number`   | _unset_ | Optional cap on the number of titles returned. |

#### `agent.getUsage(): UsageSnapshot`

Returns a **copy** of the cumulative token/usage totals since construction
(synchronous; never throws). See [Usage accounting](#usage-accounting).

## Request / response schemas

```ts
/** A retrieved context passage made available to synthesis. */
export interface ContextChunk {
  /** Stable node/document id used for citation (e.g. 'doc:42'). */
  id: string;
  /** The passage text. */
  text: string;
  /** Optional human-facing title/source. */
  title?: string;
}

export interface SynthesisRequest {
  /** The user question to answer. */
  question: string;
  /** Retrieved context, in retrieval order. Empty ⇒ the model is told it lacks grounding. */
  context: ContextChunk[];
  /** Optional per-call timeout override (ms). */
  timeoutMs?: number;
}

export interface SynthesisMetadata {
  /** Context ids the answer cited, in first-appearance order. */
  citedIds: string[];
  /** Model id that produced the answer (echoed from the SDK message). */
  model: string;
}

export interface SynthesisResult {
  /** The synthesized answer text. */
  answer: string;
  /** Structured metadata about the synthesis. */
  metadata: SynthesisMetadata;
  /** Tokens attributable to THIS call (not cumulative). */
  usage: Usage;
}

export interface ExpandQueryOptions {
  count?: number; // default 3
  timeoutMs?: number;
}

export interface MultiQueryOptions {
  count?: number; // default 3
  timeoutMs?: number;
}

export interface SeedArticleRequest {
  topic: string;
  candidates: string[];
  limit?: number;
}

/** Token counts for a single call. Mirrors the Python `_track_response` fields. */
export interface Usage {
  promptTokens: number; // SDK assistant.usage.inputTokens
  completionTokens: number; // assistant.message.outputTokens / usage.outputTokens
  reasoningTokens: number; // assistant.usage.reasoningTokens (0 if absent)
  totalTokens: number; // prompt + completion (+ reasoning)
}

/** Cumulative usage + request count since the agent was constructed. */
export interface UsageSnapshot extends Usage {
  requestCount: number;
}
```

### Transport seam

The SDK is wrapped behind a narrow interface so unit tests run **offline** with a
`vi.fn()` mock and never spawn the Copilot subprocess. This is the package's API
**stability seam**.

```ts
/** One in-flight model exchange. Maps 1:1 onto CopilotSession. */
export interface TransportSession {
  /** Sends a prompt and resolves with the assistant text + token usage. */
  send(prompt: string, timeoutMs?: number): Promise<TransportResponse>;
  /** Tears the session down (CopilotSession.disconnect). */
  close(): Promise<void>;
}

export interface TransportResponse {
  content: string;
  usage: Usage;
}

/** The injectable boundary. The real adapter wraps CopilotClient. */
export interface Transport {
  /** Opens a session pinned to a model/providers (CopilotClient.createSession). */
  open(config: { model: string; providers?: NamedProviderConfig[] }): Promise<TransportSession>;
  /** Stops the underlying client (CopilotClient.stop). */
  shutdown(): Promise<void>;
}

/** Builds the real adapter over `@github/copilot-sdk@1.0.3`. */
export function createCopilotTransport(options?: CopilotTransportOptions): Transport;
```

**Adapter mapping (verified against `@github/copilot-sdk@1.0.3`):**

| Transport concept               | SDK call                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Transport.open({model})`       | `new CopilotClient()` → `client.start()` → `client.createSession({ model, providers })`                    |
| `TransportSession.send(prompt)` | `session.sendAndWait(prompt, timeout)` → `AssistantMessageEvent`                                           |
| response `content`              | `event.data.content` (`assistant.message`)                                                                 |
| response `usage`                | `event.data.outputTokens` + the `assistant.usage` event (`inputTokens`, `outputTokens`, `reasoningTokens`) |
| `TransportSession.close()`      | `session.disconnect()`                                                                                     |
| `Transport.shutdown()`          | `client.stop()` (surfaces non-empty `Error[]`)                                                             |

## Error handling

The agent **fails closed**: it returns valid, shape-checked data or throws. It
never silently degrades (e.g. never returns a partial answer or quietly swaps in
`[query]`). Consumers such as `@kgpacks/query` own any fallback policy.

| Error                      | Thrown when                                                                                         | Carries                             |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `AgentNotStartedError`     | Any operation is called before `start()` (or after `stop()`).                                       | —                                   |
| `AgentTransportError`      | SDK start/session/`sendAndWait`/timeout/`stop` failure.                                             | `cause` (the underlying SDK error). |
| `AgentResponseFormatError` | LLM content is empty, not valid JSON after fence-stripping, or not the expected shape (`string[]`). | `rawContent` for diagnostics.       |
| `AgentError`               | Base class for all of the above (`instanceof AgentError` catches everything).                       | —                                   |

```ts
export class AgentError extends Error {}
export class AgentNotStartedError extends AgentError {}
export class AgentTransportError extends AgentError {
  readonly cause: unknown;
}
export class AgentResponseFormatError extends AgentError {
  readonly rawContent: string;
}
```

**JSON parsing.** List-returning operations strip Markdown code fences before
parsing — mirroring the Python `_strip_markdown_fences` — via the exported helper
`stripMarkdownFences(text: string): string`, then `JSON.parse`. A non-array,
non-string-array, or unparseable result raises `AgentResponseFormatError` with
the raw content attached.

**Timeouts.** `timeoutMs` (constructor default, overridable per call) is forwarded
to `sendAndWait`; a timeout rejects and is wrapped as `AgentTransportError`.

**Usage on failure.** Token usage is accrued from any assistant/usage events the
SDK delivered _before_ a failure, so `getUsage()` and budget checks stay accurate
even on partial calls.

## Usage accounting

`CopilotAgent` holds an internal usage tracker that accumulates the SDK's
`assistant.usage` (`inputTokens`, `outputTokens`, `reasoningTokens`) and the
per-message `outputTokens`, mirroring the Python `_track_response`. Each
operation returns the **per-call** `Usage`; `getUsage()` returns the **cumulative**
`UsageSnapshot` (including `requestCount`). This feeds the eval cost/quota budget
checks called out in [docs/PLAN.md](../PLAN.md) ("explicit budget/quota check
before batch runs").

## Versioning strategy

- **Package:** `0.0.0`, `private`, workspace-internal. Once the workspace
  publishes, internal SemVer applies; the `Transport` interface and the
  `CopilotAgent` method signatures are the compatibility surface. **Prompt
  strings are internal** and not part of the versioned contract (they may change
  to track eval quality without a breaking bump).
- **SDK:** pinned **exactly `1.0.3`**. Treated like the other native/heavy deps —
  pinned + lockfiled, bumped deliberately with a re-run of the agent behavioral
  tests, never floated mid-port.
- **Model:** pinned via the `DEFAULT_SYNTHESIS_MODEL` constant (BYOK), constructor-
  overridable. Per the Acceptance Criteria, the synthesis (and judge) model is
  **held constant**; changing it is a **re-baseline event**, not a routine config
  change, because it invalidates the frozen eval baseline.
- **Parity contract:** structural only. There is intentionally **no** promise of
  byte-compatible output with the Python agent — that guarantee belongs to the
  MCP/CLI/backend contracts, not here.

## Testing strategy

- **Offline by construction.** Unit tests inject a mock `Transport`, so the suite
  never spawns the Copilot CLI subprocess and runs deterministically in CI.
- **Structural parity** ([docs/PLAN.md](../PLAN.md) step 7): assert valid JSON
  shape, `string[]` seed/expansion results, citation presence in synthesis, and
  seed-title **set overlap** with the oracle — never exact answer text.
- **Behavioral checks:** fence-stripping, fail-closed errors on malformed JSON,
  cumulative usage accounting, and `start()`/`stop()` idempotency.
- **Eval, not unit tests, gate answer quality** — covered by `@kgpacks/eval`
  against the frozen baseline.

## See also

- [docs/PLAN.md](../PLAN.md) — Phase 1 port order, Spike C (Copilot SDK), and the
  parity methodology that bounds this contract.
- [docs/packages/db.md](./db.md) — sibling package API doc this one mirrors.
- [docs/monorepo.md](../monorepo.md) — workspace layout, scripts, and CI.
