// `create` / `update` — build a pack from seeds (the write-side INGESTION verbs).
//
// Both verbs share ONE implementation and ONE seam (`ctx.buildPack`): they differ
// only in how the destination pack directory is resolved (`create` makes a new
// one; `update` requires an existing one → exit 3) and in their help text. Each is
// mounted twice — top-level (`create` / `update`) and under the `pack` group
// (`pack create` / `pack update`) — by calling the same factory with a different
// parent, so the two surfaces are behaviourally identical.
//
// Configuration precedence: a `--config` JSON file (a subset of `BuildPackConfig`)
// supplies defaults; explicit CLI flags override their matching keys, and
// `--seeds` is merged with any `seeds` from the file. A run with no seed source at
// all is a usage error (exit 2). On success the command prints BOUNDED JSON counts
// (never the full arrays) and exits 0; an ingestion failure maps to exit 7.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { BuildPackConfig, BuildPackResult, ChunkOptions } from '@kgpacks/ingestion';
import {
  MANIFEST_FILENAME,
  loadManifestFromDir,
  saveManifest,
  type PackManifest,
} from '@kgpacks/packs';
import type { Command } from 'commander';

import { DB_FILENAME, DEFAULT_MAX_ARTICLES, DEFAULT_MAX_DEPTH } from '../constants.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { EXIT_USAGE } from '../exit-codes.js';
import { printJson } from '../io.js';
import { resolveNewPackDir } from '../pack-dir.js';
import { parsePositiveInt } from '../parse.js';

/** How a build verb resolves its destination pack directory. */
type PackDirResolver = (packsDir: string, name: string) => string;

/** The data-plane subset of `BuildPackConfig` the CLI assembles (no seams, no dbPath). */
type ResolvedBuildConfig = Pick<BuildPackConfig, 'seeds' | 'maxDepth' | 'maxArticles' | 'chunk'>;

/** The recognized keys read from a `--config` JSON file. */
interface FileConfig {
  seeds?: string[];
  maxDepth?: number;
  maxArticles?: number;
  chunk?: ChunkOptions;
}

/** Registers the shared `create`/`update` build verb on `parent`. */
function registerBuild(
  parent: Command,
  ctx: CliContext,
  spec: { name: string; description: string; resolvePackDir: PackDirResolver },
): Command {
  return parent
    .command(spec.name)
    .description(spec.description)
    .requiredOption('--pack <name>', 'pack directory name')
    .option('--seeds <url...>', 'seed article URLs (HTTPS)')
    .option('--config <file>', 'JSON config file (a subset of BuildPackConfig)')
    .option(
      '--max-depth <n>',
      'maximum link-expansion depth from the seeds',
      parsePositiveInt,
      DEFAULT_MAX_DEPTH,
    )
    .option(
      '--max-articles <n>',
      'hard cap on the number of articles ingested',
      parsePositiveInt,
      DEFAULT_MAX_ARTICLES,
    )
    .option('--chunk-size <n>', 'section→chunk window size (characters)', parsePositiveInt)
    .option(
      '--chunk-overlap <n>',
      'overlap between consecutive chunks (characters)',
      parsePositiveInt,
    )
    .action(async (_opts: unknown, command: Command) => {
      await runBuild(ctx, command, spec.resolvePackDir);
    });
}

/** Registers `create` (build a new pack) on `parent`. */
export function registerCreate(parent: Command, ctx: CliContext): Command {
  return registerBuild(parent, ctx, {
    name: 'create',
    description: 'Build a new pack database from seed URLs or a config file.',
    resolvePackDir: resolveNewPackDir,
  });
}

/** Resolves the build config, validates it, runs the seam, and prints counts. */
async function runBuild(
  ctx: CliContext,
  command: Command,
  resolvePackDir: PackDirResolver,
): Promise<void> {
  const opts = command.optsWithGlobals();
  const config = resolveBuildConfig(command, opts);

  if (config.seeds.length === 0) {
    // Usage error (exit 2): no seeds anywhere. Reported before any pack directory
    // is touched, so a missing-seed `create` never creates a stray directory.
    command.error(
      'requires at least one seed source: pass --seeds <url...> or --config <file> with "seeds".',
    );
  }

  const packsDir = ctx.packsDirFor(opts.packsDir as string | undefined);
  const packDir = resolvePackDir(packsDir, opts.pack as string);
  const dbPath = join(packDir, DB_FILENAME);

  const result = await ctx.buildPack({ ...config, dbPath });
  writePackManifest(packDir, opts.pack as string, dbPath, result);

  printJson(ctx.io, {
    pack: opts.pack as string,
    dbPath: result.dbPath,
    articles: result.articles.length,
    sections: result.sections.length,
    chunks: result.chunks.length,
    entities: result.entities.length,
    relationships: result.relationships.length,
    links: result.links.length,
    skipped: result.skipped.length,
  });
}

/**
 * Writes the pack's `manifest.json` next to its `pack.db` so the built pack is
 * discoverable by `pack list`/`info`/`validate` and installable. Without this a
 * created pack is invisible to the whole pack-management subsystem. On `update`,
 * an existing manifest's identity (name/version/description) is preserved and only
 * `graph_stats` is refreshed; `create` writes a fresh manifest. `size_mb` is
 * best-effort (0 when the database is in-memory / not on disk).
 */
function writePackManifest(
  packDir: string,
  packName: string,
  dbPath: string,
  result: BuildPackResult,
): void {
  let existing: Partial<PackManifest> = {};
  try {
    existing = loadManifestFromDir(packDir);
  } catch {
    // No (or invalid) prior manifest — fall through to fresh defaults.
  }

  let sizeMb = 0;
  try {
    sizeMb = Math.round((statSync(dbPath).size / (1024 * 1024)) * 100) / 100;
  } catch {
    // Database not on disk (e.g. an in-memory build) — report 0.
  }

  const manifest: PackManifest = {
    name: typeof existing.name === 'string' ? existing.name : packName,
    version: typeof existing.version === 'string' ? existing.version : '1.0.0',
    ...(typeof existing.description === 'string' ? { description: existing.description } : {}),
    graph_stats: {
      articles: result.articles.length,
      entities: result.entities.length,
      relationships: result.relationships.length,
      size_mb: sizeMb,
    },
  };
  saveManifest(join(packDir, MANIFEST_FILENAME), manifest);
}

/**
 * Folds `--config` and the CLI flags into the data-plane build config. Explicit
 * flags win over the file; `--seeds` is merged with the file's `seeds` (deduped,
 * file entries first).
 */
function resolveBuildConfig(command: Command, opts: Record<string, unknown>): ResolvedBuildConfig {
  const file: FileConfig = opts.config ? readConfigFile(opts.config as string) : {};

  const flagSeeds = (opts.seeds as string[] | undefined) ?? [];
  const seeds = dedupe([...(file.seeds ?? []), ...flagSeeds]);

  const config: ResolvedBuildConfig = {
    seeds,
    maxDepth: pickNumber(command, opts, 'maxDepth', file.maxDepth),
    maxArticles: pickNumber(command, opts, 'maxArticles', file.maxArticles),
  };

  const chunk = resolveChunk(opts, file.chunk);
  if (chunk !== undefined) {
    config.chunk = chunk;
  }
  return config;
}

/**
 * Resolves a bounded integer with flag-wins-over-file precedence. An explicitly
 * supplied flag (`getOptionValueSource === 'cli'`) wins; otherwise the file value
 * is used when present, falling back to the commander default.
 */
function pickNumber(
  command: Command,
  opts: Record<string, unknown>,
  name: string,
  fileValue: number | undefined,
): number {
  if (command.getOptionValueSource(name) === 'cli') {
    return opts[name] as number;
  }
  return fileValue ?? (opts[name] as number);
}

/**
 * Merges the chunk options. `--chunk-size` / `--chunk-overlap` (no commander
 * default, so present only when supplied) override their file counterparts.
 * Returns `undefined` when neither the flags nor the file specify any chunking, so
 * `buildPack` applies its own defaults.
 */
function resolveChunk(
  opts: Record<string, unknown>,
  fileChunk: ChunkOptions | undefined,
): ChunkOptions | undefined {
  const flag: ChunkOptions = {};
  if (opts.chunkSize !== undefined) flag.size = opts.chunkSize as number;
  if (opts.chunkOverlap !== undefined) flag.overlap = opts.chunkOverlap as number;

  if (flag.size === undefined && flag.overlap === undefined) {
    return fileChunk;
  }
  return { ...(fileChunk ?? {}), ...flag };
}

/** Reads + validates the recognized data-plane keys from a `--config` JSON file. */
function readConfigFile(path: string): FileConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new CliError(
      `failed to read --config file '${path}': ${(err as Error).message}`,
      EXIT_USAGE,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`--config file '${path}' must be a JSON object.`, EXIT_USAGE);
  }

  const obj = parsed as Record<string, unknown>;
  const config: FileConfig = {};

  if (obj.seeds !== undefined) {
    if (!Array.isArray(obj.seeds) || !obj.seeds.every((s) => typeof s === 'string')) {
      throw new CliError(`--config 'seeds' must be an array of strings.`, EXIT_USAGE);
    }
    config.seeds = obj.seeds as string[];
  }
  if (obj.maxDepth !== undefined) config.maxDepth = asPositiveInt(obj.maxDepth, 'maxDepth', path);
  if (obj.maxArticles !== undefined) {
    config.maxArticles = asPositiveInt(obj.maxArticles, 'maxArticles', path);
  }
  if (obj.chunk !== undefined) {
    if (typeof obj.chunk !== 'object' || obj.chunk === null || Array.isArray(obj.chunk)) {
      throw new CliError(`--config 'chunk' must be an object.`, EXIT_USAGE);
    }
    const raw = obj.chunk as Record<string, unknown>;
    const chunk: ChunkOptions = {};
    if (raw.size !== undefined) chunk.size = asPositiveInt(raw.size, 'chunk.size', path);
    if (raw.overlap !== undefined)
      chunk.overlap = asPositiveInt(raw.overlap, 'chunk.overlap', path);
    config.chunk = chunk;
  }
  return config;
}

/** Validates a config field is a positive integer. */
function asPositiveInt(value: unknown, field: string, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new CliError(`--config '${field}' in '${path}' must be a positive integer.`, EXIT_USAGE);
  }
  return value;
}

/** Returns the input with duplicate entries removed, preserving first-seen order. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
