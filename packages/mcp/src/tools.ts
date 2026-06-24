// The three knowledge-pack tools, ported from the upstream `mcp_server`.
//
// Each tool's observable behavior — argument names/types, success JSON, and
// error JSON — is reproduced byte-for-byte. The tool bodies are split into pure
// `*Text` functions (filesystem in, string out) so they can be asserted directly,
// plus a `registerTools` binding that exposes them over the MCP SDK with the
// snapshot-locked input schemas.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { PACK_NAME_RE } from '@kgpacks/packs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  DB_FILENAME,
  DEFAULT_MAX_RESULTS,
  LIST_PACKS_DESCRIPTION,
  MAX_MAX_RESULTS,
  PACK_INFO_DESCRIPTION,
  QUERY_KNOWLEDGE_PACK_DESCRIPTION,
  TOOL_LIST_PACKS,
  TOOL_PACK_INFO,
  TOOL_QUERY_KNOWLEDGE_PACK,
  URLS_FILENAME,
  packNotFoundMessage,
} from './constants.js';
import { dumpCompact, dumpIndented } from './json.js';
import { loadManifestLenient } from './manifest-io.js';
import type { QueryRunner } from './query-runner.js';

/** Runtime configuration shared by all three tools. */
export interface ToolConfig {
  /** Directory scanned for installed packs. */
  packsDir: string;
  /** Seam used by `query_knowledge_pack` to answer questions. */
  runQuery: QueryRunner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `dict.get(key, fallback)` semantics over a parsed manifest. */
function pick(obj: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return key in obj ? obj[key] : fallback;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves a pack directory by name, enforcing path safety.
 *
 * `pack_name` is validated against `PACK_NAME_RE` before any path is built — so a
 * traversal attempt (`../`, separators, odd leading chars) can never escape
 * `packsDir`. Both an invalid name and a missing directory raise the same
 * "not found" error the upstream `_get_pack_dir` raises, so the two cases are
 * indistinguishable to callers.
 */
function resolvePackDir(packsDir: string, packName: string): string {
  if (!PACK_NAME_RE.test(packName)) {
    throw new Error(packNotFoundMessage(packName));
  }
  const dir = join(packsDir, packName);
  if (!isDirectory(dir)) {
    throw new Error(packNotFoundMessage(packName));
  }
  return dir;
}

/**
 * `list_packs` — JSON array of `{ name, description, article_count }` for every
 * pack directory under `packsDir`, sorted by directory name. A missing packs
 * directory returns the upstream compact `{ error, path }` payload.
 */
export function listPacksText(packsDir: string): string {
  let dirents;
  try {
    dirents = readdirSync(packsDir, { withFileTypes: true });
  } catch {
    return dumpCompact({ error: 'Packs directory not found', path: packsDir });
  }

  const packs = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort()
    .map((name) => {
      // Isolate per-pack failures: one corrupt manifest.json must not fail listing
      // every other pack (mirror the missing-file stand-in).
      let manifest;
      try {
        manifest = loadManifestLenient(join(packsDir, name));
      } catch {
        return { name, description: '', article_count: 0 };
      }
      const graphStats = manifest['graph_stats'];
      return {
        name: pick(manifest, 'name', name),
        description: pick(manifest, 'description', ''),
        article_count: isRecord(graphStats) ? pick(graphStats, 'articles', 0) : 0,
      };
    });

  return dumpIndented(packs);
}

/**
 * `pack_info` — the pack's full manifest plus the computed `db_exists` and
 * `urls_file_exists` flags. Throws the "not found" error for an unknown or
 * invalid pack name.
 */
export function packInfoText(packsDir: string, packName: string): string {
  const packDir = resolvePackDir(packsDir, packName);
  const manifest = loadManifestLenient(packDir);
  manifest['db_exists'] = existsSync(join(packDir, DB_FILENAME));
  manifest['urls_file_exists'] = existsSync(join(packDir, URLS_FILENAME));
  return dumpIndented(manifest);
}

/**
 * `query_knowledge_pack` — resolves the pack, confirms its database exists, then
 * delegates to `config.runQuery`. Missing database and runner failures return the
 * upstream compact error payloads; success serializes the runner result with
 * 2-space indentation.
 */
export async function queryKnowledgePackText(
  config: ToolConfig,
  packName: string,
  question: string,
  maxResults: number,
): Promise<string> {
  const packDir = resolvePackDir(config.packsDir, packName);
  const dbPath = join(packDir, DB_FILENAME);
  if (!existsSync(dbPath)) {
    return dumpCompact({ error: `Database not found at ${dbPath}` });
  }

  let result: unknown;
  try {
    result = await config.runQuery({ packName, dbPath, question, maxResults });
  } catch (err) {
    return dumpCompact({ error: err instanceof Error ? err.message : String(err), pack: packName });
  }

  return dumpIndented(result);
}

function textResult(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] };
}

/** Registers the three tools on `server`, bound to `config`. */
export function registerTools(server: McpServer, config: ToolConfig): void {
  server.registerTool(
    TOOL_LIST_PACKS,
    { description: LIST_PACKS_DESCRIPTION, inputSchema: {} },
    () => textResult(listPacksText(config.packsDir)),
  );

  server.registerTool(
    TOOL_PACK_INFO,
    { description: PACK_INFO_DESCRIPTION, inputSchema: { pack_name: z.string() } },
    ({ pack_name }) => textResult(packInfoText(config.packsDir, pack_name)),
  );

  server.registerTool(
    TOOL_QUERY_KNOWLEDGE_PACK,
    {
      description: QUERY_KNOWLEDGE_PACK_DESCRIPTION,
      inputSchema: {
        pack_name: z.string(),
        question: z.string(),
        max_results: z.number().int().min(1).max(MAX_MAX_RESULTS).default(DEFAULT_MAX_RESULTS),
      },
    },
    async ({ pack_name, question, max_results }) =>
      textResult(await queryKnowledgePackText(config, pack_name, question, max_results)),
  );
}
