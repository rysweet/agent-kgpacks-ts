# @kgpacks/mcp

TypeScript [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes installed knowledge packs to MCP clients (VS Code / GitHub Copilot, Claude
Desktop). It is a strict-ESM port of the Python `mcp_server.py` and a **drop-in
replacement**: same stdio transport, same tool names, argument names/types, and
result shapes.

## Tools

| Tool                   | Arguments                                                            | Result                                                                                         |
| ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `list_packs`           | _(none)_                                                             | JSON array of `{ name, description, article_count }` for every pack, sorted by directory name. |
| `pack_info`            | `pack_name: string`                                                  | The pack's full `manifest.json` plus computed `db_exists` / `urls_file_exists` flags.          |
| `query_knowledge_pack` | `pack_name: string`, `question: string`, `max_results?: integer = 5` | Answer synthesized from the pack's knowledge graph (delegated to the query seam).              |

The on-the-wire tool schema is locked by a snapshot test
(`test/__snapshots__/schema-contract.test.ts.snap`) — the authoritative external
contract that VS Code / Claude Desktop configurations depend on. Changing it is a
deliberate, reviewed act.

## Packs directory

The server scans `KGPACKS_PACKS_DIR` if set, otherwise `<cwd>/data/packs` (the
Python server's layout — the launch configs below set `cwd` to the repo root).

## Running

```bash
pnpm --filter @kgpacks/mcp build
node packages/mcp/dist/bin.js          # or the `kgpacks-mcp` bin
```

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

## Programmatic API

```ts
import { createServer, runStdioServer, type QueryRunner } from '@kgpacks/mcp';

// Serve over stdio with production defaults:
await runStdioServer();

// Or inject a packs directory and a custom query backend:
const runQuery: QueryRunner = async ({ packName, dbPath, question, maxResults }) => {
  /* ... return any JSON-serializable result ... */
};
const server = createServer({ packsDir: '/data/packs', runQuery });
```

`query_knowledge_pack` delegates to an injectable `QueryRunner`. The Phase-1
default (`defaultQueryRunner`) runs the CORE retrieval pipeline
(`@kgpacks/db` + `@kgpacks/query`) over the pack's LadybugDB; LLM answer synthesis
lands when `@kgpacks/agent` is wired in a later slice. The seam keeps the heavy
stack off the hot path (lazy-imported on first query) and makes the tools fully
testable with a fixture runner.

## Parity notes

- Server identity (`name: "agent-kgpacks"`, `instructions`) is ported verbatim
  from the Python source. The human-readable tool descriptions are adapted from
  the upstream docstrings (example pack renamed to one the TS port ships, query
  description condensed); they are locked by the schema snapshot but are not part
  of the load-bearing config contract.
- Success payloads use `JSON.stringify(value, null, 2)` (byte-identical to Python
  `json.dumps(..., indent=2)` for ASCII content); error payloads reproduce
  Python's compact `", "` / `": "` separators.
- `pack_name` is validated against `PACK_NAME_RE` before any path is built, so
  traversal attempts are rejected with the same "not found" message as an unknown
  pack.

See [docs/packages/mcp.md](../../docs/packages/mcp.md) for the full design and
parity contract, [docs/PLAN.md](../../docs/PLAN.md) ("External Contracts") for the
parity requirement, and [docs/monorepo.md](../../docs/monorepo.md) for the
workspace conventions.
