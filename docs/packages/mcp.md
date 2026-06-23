# `@kgpacks/mcp`

A strict-ESM [Model Context Protocol](https://modelcontextprotocol.io) server
(stdio transport) that exposes installed knowledge packs to MCP clients — VS Code
/ GitHub Copilot and Claude Desktop. It is a **drop-in replacement** for the
upstream Python `mcp_server.py`: same transport, same tool names, same argument
names/types, and the same on-the-wire result shapes.

> **The external contract is the point of this package.** Editor and desktop
> launch configurations reference these tool names and argument schemas directly.
> They are byte-compatible with the upstream server and locked by a snapshot test
> (`test/__snapshots__/schema-contract.test.ts.snap`). Changing the surface is a
> deliberate, reviewed act — see [Parity notes](#parity-notes) and
> [docs/PLAN.md](../PLAN.md) ("External Contracts").

- **Tools:** `list_packs`, `pack_info`, `query_knowledge_pack`.
- **Transport:** stdio (JSON-RPC over stdout/stdin) via
  `@modelcontextprotocol/sdk`.
- **Module system:** native ESM. The server core is dependency-light; the heavy
  retrieval stack is lazy-imported on first query only.
- **Workspace dependencies:** `@kgpacks/packs` (manifest filename + `PACK_NAME_RE`
  safety gate), and — only inside the Phase-1 query runner — `@kgpacks/db` +
  `@kgpacks/query`.

## Architecture

The package is a thin, fully testable wiring layer around the MCP SDK. Each
concern is a small module so the load-bearing logic can be asserted directly
(filesystem in, string out) without a live transport:

```
bin.ts          #!/usr/bin/env node — boots the stdio server, logs to stderr
  └─ stdio.ts        runStdioServer(): connect server to StdioServerTransport
       └─ server.ts       createServer(): McpServer identity + registerTools
            └─ tools.ts        the 3 tools — pure *Text fns + registerTools binding
                 ├─ constants.ts     server name/instructions, tool names + descriptions
                 ├─ json.ts          dumpIndented / dumpCompact (upstream JSON parity)
                 ├─ manifest-io.ts   loadManifestLenient (port of _load_manifest)
                 ├─ config.ts        resolveDefaultPacksDir ($KGPACKS_PACKS_DIR | cwd/data/packs)
                 └─ query-runner.ts  QueryRunner seam + lazy defaultQueryRunner
```

Each tool body is split into a **pure `*Text` function** (deterministic,
synchronous where possible, returns the exact JSON string the client receives)
plus a thin `registerTools` binding that wraps the SDK schema generation and
result framing. Tests exercise both the pure functions and the real protocol
round-trip.

## Installation

`@kgpacks/mcp` is an internal workspace package. From the repo root:

```bash
pnpm install
pnpm --filter @kgpacks/mcp build
pnpm --filter @kgpacks/mcp test
```

The build emits `dist/`, including the `kgpacks-mcp` bin (`dist/bin.js`).

## Running

```bash
pnpm --filter @kgpacks/mcp build
node packages/mcp/dist/bin.js        # or the `kgpacks-mcp` bin once linked
```

The server scans `$KGPACKS_PACKS_DIR` when set, otherwise `<cwd>/data/packs` —
the upstream layout (the launch configs below set `cwd` to the repo root).
stdout is reserved for the JSON-RPC stream; startup failures are logged to
stderr before a non-zero exit.

VS Code (`settings.json`, GitHub Copilot):

```json
{
  "mcp": {
    "servers": {
      "kgpacks": {
        "command": "node",
        "args": ["packages/mcp/dist/bin.js"],
        "cwd": "/path/to/agent-kgpacks-ts"
      }
    }
  }
}
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kgpacks": {
      "command": "node",
      "args": ["packages/mcp/dist/bin.js"],
      "cwd": "/path/to/agent-kgpacks-ts"
    }
  }
}
```

## Quick start (programmatic)

```ts
import { createServer, runStdioServer, type QueryRunner } from '@kgpacks/mcp';

// Serve over stdio with production defaults (packs dir + lazy retrieval runner):
await runStdioServer();

// Or inject a packs directory and a custom query backend (e.g. a test fixture):
const runQuery: QueryRunner = async ({ packName, dbPath, question, maxResults }) => {
  // ...return any JSON-serializable value; it is serialized verbatim into the result.
  return { pack: packName, question, results: [] };
};
const server = createServer({ packsDir: '/data/packs', runQuery });
```

## The external contract

| Tool                   | Arguments                                                            | Result                                                                                           |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `list_packs`           | _(none)_                                                             | 2-space JSON array of `{ name, description, article_count }` for every pack, sorted by dir name. |
| `pack_info`            | `pack_name: string`                                                  | The pack's full `manifest.json` plus computed `db_exists` / `urls_file_exists` flags.            |
| `query_knowledge_pack` | `pack_name: string`, `question: string`, `max_results?: integer = 5` | The query runner's result, serialized verbatim (Phase-1: CORE retrieval hits; synthesis later).  |

What the snapshot locks (the parts editor/desktop configs depend on):

- **Server identity** — `name: "agent-kgpacks"` and the instructions string
  (verbatim from upstream `FastMCP(name=..., instructions=...)`).
- **Tool names** — exactly the three above, byte-for-byte.
- **Input schemas** — argument names, JSON-Schema types (`string`, `integer`),
  the `max_results` default of `5`, and the required set
  (`list_packs`: none; `pack_info`: `[pack_name]`; `query_knowledge_pack`:
  `[pack_name, question]`).
- **Result framing** — every tool returns a single `text` content block whose
  body is the JSON string described below; a thrown error becomes an `isError`
  result carrying the ported message.

### Result & error payloads (byte parity)

Success payloads use 2-space-indented JSON (`JSON.stringify(value, null, 2)`,
byte-identical to Python `json.dumps(value, indent=2)` for ASCII content). Error
payloads reproduce Python's **default compact separators** `", "` / `": "` —
which differ from `JSON.stringify`'s separator-less compact form, so they are
reconstructed by `dumpCompact`:

| Condition                                 | Payload                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `list_packs`, packs dir missing           | `{"error": "Packs directory not found", "path": <packsDir>}`               |
| `pack_info` / query, unknown/invalid pack | thrown `Pack '<name>' not found. Use list_packs() to see available packs.` |
| `query_knowledge_pack`, `pack.db` missing | `{"error": "Database not found at <dbPath>"}`                              |
| `query_knowledge_pack`, runner throws     | `{"error": <message>, "pack": <packName>}`                                 |

## API reference

### `createServer(options?: CreateServerOptions): McpServer`

Builds a configured (but not yet connected) `McpServer` with the ported identity
and the three tools registered.

```ts
interface CreateServerOptions {
  packsDir?: string; // default: resolveDefaultPacksDir()
  runQuery?: QueryRunner; // default: defaultQueryRunner()
}
```

Both seams are injectable; unset, they fall back to the production defaults.

### `runStdioServer(options?: CreateServerOptions): Promise<void>`

Creates the server (same options) and connects it to `StdioServerTransport`,
serving until the transport closes. This is what `bin.ts` calls.

### `registerTools(server: McpServer, config: ToolConfig): void`

Registers the three tools on an existing server, bound to `config`.

```ts
interface ToolConfig {
  packsDir: string; // directory scanned for installed packs
  runQuery: QueryRunner; // seam used by query_knowledge_pack
}
```

### Pure tool functions

These are the testable cores; `registerTools` wraps them for the wire.

- **`listPacksText(packsDir: string): string`** — 2-space JSON array of
  `{ name, description, article_count }` for each subdirectory, sorted by name.
  `name`/`description` come from the manifest (falling back to the directory name
  and `""`); `article_count` reads `graph_stats.articles` (0 when absent). Loose
  files at the packs root are ignored. A missing packs directory returns the
  compact `{ error, path }` payload.
- **`packInfoText(packsDir: string, packName: string): string`** — the pack's
  full (lenient) manifest with computed `db_exists` / `urls_file_exists` flags
  appended, 2-space indented. Throws the "not found" message for an unknown or
  invalid pack name.
- **`queryKnowledgePackText(config, packName, question, maxResults): Promise<string>`**
  — resolves the pack, confirms `pack.db` exists, then delegates to
  `config.runQuery`. Missing database and runner failures return the compact
  error payloads; success serializes the runner's resolved value with 2-space
  indentation.

### The query seam

`query_knowledge_pack` delegates answering to an injectable runner. This keeps
the tool wiring fully testable with a fixture and keeps the heavy retrieval
stack off the hot path until a query is actually issued — mirroring the upstream
server, which lazily imports its agent inside the tool body so listing packs
never pays for it.

```ts
interface QueryRunnerInput {
  packName: string; // already validated + resolved by the server
  dbPath: string; // absolute path to pack.db (already confirmed to exist)
  question: string;
  maxResults: number;
}

type QueryRunner = (input: QueryRunnerInput) => Promise<unknown>;
```

The resolved value is serialized verbatim into the tool result, so any
JSON-serializable shape is accepted — production wiring and test fixtures alike.

**`defaultQueryRunner(): QueryRunner`** builds the Phase-1 production runner. It
lazily `import()`s `@kgpacks/db` and `@kgpacks/query` on first call, opens the
pack database read-side, runs `createRetriever(conn).retrieve(question, { k })`,
and returns:

```ts
interface DefaultQueryResult {
  pack: string;
  question: string;
  max_results: number;
  results: RetrieverResult[]; // ranked CORE retrieval hits
}
```

> **Phase boundary.** Phase 1 returns ranked retrieval hits. The upstream
> server's synthesized natural-language `answer` (and `sources`/`entities`/…)
> lands when `@kgpacks/agent` is wired into the runner in a later slice. Because
> the runner type is shape-agnostic and the result is serialized verbatim, that
> swap is a drop-in with no change to the tool wiring or schema.

### Manifest, config & JSON helpers

- **`loadManifestLenient(packDir: string): RawManifest`** — a faithful port of
  the upstream `_load_manifest`. Unlike `@kgpacks/packs`' strict
  `loadManifestFromDir`, it does **no** schema validation: a missing
  `manifest.json` yields `{ name: <dir basename>, error: 'manifest.json missing' }`;
  a present file is returned exactly as parsed; a malformed file propagates the
  `JSON.parse` error (as upstream `json.loads` would raise). The
  `manifest.json` filename is reused from `@kgpacks/packs` (`MANIFEST_FILENAME`)
  so the on-disk convention has a single source of truth.
- **`resolveDefaultPacksDir(env?, cwd?): string`** — returns the
  `KGPACKS_PACKS_DIR` override when set to a non-empty value, otherwise
  `<cwd>/data/packs`.
- **`dumpIndented(value): string`** / **`dumpCompact(value): string`** — the two
  JSON serializers that reproduce upstream's `json.dumps` formats (see
  [Result & error payloads](#result--error-payloads-byte-parity)).

### Constants

`SERVER_NAME`, `SERVER_VERSION`, `SERVER_INSTRUCTIONS`, `PACKS_DIR_ENV`,
`DB_FILENAME` (`pack.db`), `URLS_FILENAME` (`urls.txt`), `DEFAULT_MAX_RESULTS`
(`5`), the three `TOOL_*` names, and `packNotFoundMessage(packName)` (the
byte-for-byte upstream "not found" text).

## Configuration

| Variable            | Default            | Meaning                                     |
| ------------------- | ------------------ | ------------------------------------------- |
| `KGPACKS_PACKS_DIR` | `<cwd>/data/packs` | Root directory scanned for installed packs. |

A pack is any immediate subdirectory of the packs root. Per pack, the server
probes `manifest.json` (lenient), `pack.db` (the LadybugDB database), and
`urls.txt` (source URL list). Loose files at the root are ignored.

## Security model

- **Path-safety gate.** `pack_name` is validated against `@kgpacks/packs`'
  `PACK_NAME_RE` _before_ any path is built, so traversal attempts (`../`,
  separators, odd leading characters) can never escape `packsDir`. An invalid
  name and a missing directory raise the **same** "not found" error, so the two
  cases are indistinguishable to callers — exactly as upstream `_get_pack_dir`.
- **Lazy heavy imports.** The database driver and retrieval/embedding runtime are
  only loaded inside `defaultQueryRunner` on the first `query_knowledge_pack`
  call. Constructing the server and running `list_packs` / `pack_info` never
  touch them.
- **Reserved stdout.** stdout carries the JSON-RPC protocol stream only; all
  diagnostics go to stderr. `bin.ts` logs startup failures to stderr and exits
  non-zero.

## Parity notes

- **Verbatim:** server `name`, `instructions`, the three tool names, the strict
  input schemas (arg names/types/defaults/required), the success/error JSON
  formats, and the "not found" / "Database not found" / packs-dir-missing
  messages.
- **Adapted (intentional):** the human-readable **tool descriptions** are derived
  from the upstream docstrings but not byte-identical — the example pack name was
  changed from `python-expert` to `rust-expert` (a pack the TS port ships), and
  the `query_knowledge_pack` description was condensed (dropping the
  implementation-detail reference to the upstream `KnowledgeGraphAgent` class).
  Descriptions are client hints, not part of the load-bearing config contract;
  the chosen text is nonetheless locked by the schema snapshot so any future
  drift is a reviewed change.
- **Result shape:** Phase 1 returns CORE retrieval hits rather than a synthesized
  answer (see [the query seam](#the-query-seam)). The wire envelope, tool schema,
  and error contract are unchanged, so the synthesis upgrade is transparent to
  clients.

## Testing strategy

28 tests (all passing) cover three layers:

- **Pure tool functions** (`list-packs`, `pack-info`, `query-knowledge-pack`,
  `config`) — byte-exact success/error strings, the manifest-name fallback,
  loose-file filtering, the missing-db/runner-failure payloads, and the
  `PACK_NAME_RE` traversal rejections — driven by an on-disk
  [`makeMockPacks`](../../packages/mcp/test/helpers/mock-packs.ts) fixture built
  in code (no committed binary `pack.db`).
- **Schema contract** (`schema-contract.test.ts`) — connects an in-process MCP
  `Client` to the real server over a linked in-memory transport and snapshots the
  full `tools/list` payload, plus targeted assertions on the load-bearing fields.
  This is the authoritative external-contract guard.
- **End-to-end** (`server.e2e.test.ts`) — `tools/call` round-trips through the SDK
  verifying result content, the over-the-wire `max_results` default, the resolved
  runner inputs, and that a thrown "not found" surfaces as an `isError` result.

## See also

- [docs/PLAN.md](../PLAN.md) — "External Contracts" (the MCP parity requirement)
  and the overall port plan.
- [docs/monorepo.md](../monorepo.md) — workspace layout and conventions.
- [docs/packages/packs.md](./packs.md) — `@kgpacks/packs` (`MANIFEST_FILENAME`,
  `PACK_NAME_RE`, manifest model) that this server builds on.
- [docs/packages/db.md](./db.md) — `@kgpacks/db`, the LadybugDB wrapper the
  default query runner opens (alongside the `@kgpacks/query` retriever it drives).
- [docs/packages/parity.md](./parity.md) — the dev-time parity harness and
  methodology.
