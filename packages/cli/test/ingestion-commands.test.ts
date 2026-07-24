// packages/cli/test/ingestion-commands.test.ts
//
// Behaviour + exit-code contract for the Phase-2 INGESTION commands: `create`
// and `research-sources` — plus the dual-surface `pack create` mount. Incremental
// update has its own immutable base/delta contract suite. The heavy write-side stack is never loaded: each command
// delegates to an injected seam (`buildPack` / `discoverSources`) so the suite is
// fully offline.
//
// These tests define the contract the implementation must satisfy; they fail
// until the commands and their seams exist.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DB_FILENAME } from '../src/constants.js';
import { EXIT_OK } from '../src/exit-codes.js';
import { makeMockPacks, type MockPacks } from './helpers/mock-packs.js';
import {
  BUILD_COUNTS,
  INGEST_DEFAULTS,
  expectedBuildCounts,
  makeBuildResult,
} from './helpers/phase2.js';
import { parseStdout, runCli } from './helpers/run-cli.js';

// New write-side exit codes (mirrors EXIT_INGESTION in src/exit-codes.ts).
const EXIT_INGESTION = 7;

let packs: MockPacks;
const SEED_A = 'https://en.wikipedia.org/wiki/Ada_Lovelace';
const SEED_B = 'https://en.wikipedia.org/wiki/Charles_Babbage';

/** A `buildPack` seam double that echoes `config.dbPath` into a fixed-counts result. */
function fakeBuildPack() {
  return vi.fn(async (config: { dbPath?: string }) => makeBuildResult(config.dbPath ?? ':memory:'));
}

beforeEach(() => {
  packs = makeMockPacks();
});
afterEach(() => {
  packs.cleanup();
});

describe('create', () => {
  it('builds a new pack from --seeds and prints bounded JSON counts (exit 0)', async () => {
    const buildPack = fakeBuildPack();
    const dbPath = join(packs.packsDir, 'gamma-pack', DB_FILENAME);

    const result = await runCli(['create', '--pack', 'gamma-pack', '--seeds', SEED_A, SEED_B], {
      packsDir: packs.packsDir,
      buildPack,
    });

    expect(result.code).toBe(EXIT_OK);
    expect(buildPack).toHaveBeenCalledTimes(1);
    expect(buildPack).toHaveBeenCalledWith(
      expect.objectContaining({
        seeds: [SEED_A, SEED_B],
        dbPath,
        maxDepth: INGEST_DEFAULTS.maxDepth,
        maxArticles: INGEST_DEFAULTS.maxArticles,
      }),
    );
    // No chunk flags → no chunk options forwarded (ingestion applies its own defaults).
    expect((buildPack.mock.calls[0][0] as { chunk?: unknown }).chunk).toBeUndefined();
    expect(parseStdout(result)).toEqual(expectedBuildCounts('gamma-pack', dbPath));
  });

  it('creates the destination pack directory before building', async () => {
    const buildPack = fakeBuildPack();
    expect(existsSync(join(packs.packsDir, 'gamma-pack'))).toBe(false);

    await runCli(['create', '--pack', 'gamma-pack', '--seeds', SEED_A], {
      packsDir: packs.packsDir,
      buildPack,
    });

    expect(existsSync(join(packs.packsDir, 'gamma-pack'))).toBe(true);
  });

  it('forwards --max-depth / --max-articles / --chunk-size / --chunk-overlap to the seam', async () => {
    const buildPack = fakeBuildPack();

    await runCli(
      [
        'create',
        '--pack',
        'gamma-pack',
        '--seeds',
        SEED_A,
        '--max-depth',
        '3',
        '--max-articles',
        '12',
        '--chunk-size',
        '256',
        '--chunk-overlap',
        '32',
      ],
      { packsDir: packs.packsDir, buildPack },
    );

    expect(buildPack).toHaveBeenCalledWith(
      expect.objectContaining({
        seeds: [SEED_A],
        maxDepth: 3,
        maxArticles: 12,
        chunk: { size: 256, overlap: 32 },
      }),
    );
  });

  it('reads seeds and bounds from a --config JSON file', async () => {
    const buildPack = fakeBuildPack();
    const cfgDir = mkdtempSync(join(tmpdir(), 'kgpacks-cfg-'));
    const cfgPath = join(cfgDir, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        seeds: [SEED_A, SEED_B],
        maxDepth: 2,
        maxArticles: 7,
        chunk: { size: 128, overlap: 16 },
      }),
    );

    try {
      const result = await runCli(['create', '--pack', 'gamma-pack', '--config', cfgPath], {
        packsDir: packs.packsDir,
        buildPack,
      });
      expect(result.code).toBe(EXIT_OK);
      expect(buildPack).toHaveBeenCalledWith(
        expect.objectContaining({
          seeds: [SEED_A, SEED_B],
          maxDepth: 2,
          maxArticles: 7,
          chunk: { size: 128, overlap: 16 },
        }),
      );
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it('lets an explicit --max-depth flag override the config file value', async () => {
    const buildPack = fakeBuildPack();
    const cfgDir = mkdtempSync(join(tmpdir(), 'kgpacks-cfg-'));
    const cfgPath = join(cfgDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ seeds: [SEED_A], maxDepth: 2, maxArticles: 7 }));

    try {
      await runCli(['create', '--pack', 'gamma-pack', '--config', cfgPath, '--max-depth', '5'], {
        packsDir: packs.packsDir,
        buildPack,
      });
      const config = buildPack.mock.calls[0][0] as { maxDepth: number; maxArticles: number };
      expect(config.maxDepth).toBe(5); // flag wins
      expect(config.maxArticles).toBe(7); // untouched config value preserved
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it('includes flag-provided seeds when both --config and --seeds are present', async () => {
    const buildPack = fakeBuildPack();
    const cfgDir = mkdtempSync(join(tmpdir(), 'kgpacks-cfg-'));
    const cfgPath = join(cfgDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ seeds: [SEED_A] }));

    try {
      await runCli(['create', '--pack', 'gamma-pack', '--config', cfgPath, '--seeds', SEED_B], {
        packsDir: packs.packsDir,
        buildPack,
      });
      const config = buildPack.mock.calls[0][0] as { seeds: string[] };
      expect(config.seeds).toEqual(expect.arrayContaining([SEED_B]));
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it('maps an ingestion-side failure to exit 7 (IngestionError family, by name)', async () => {
    const buildPack = vi.fn(async () => {
      const err = new Error('host resolved to a private address');
      err.name = 'BlockedUrlError';
      throw err;
    });

    const result = await runCli(['create', '--pack', 'gamma-pack', '--seeds', SEED_A], {
      packsDir: packs.packsDir,
      buildPack,
    });

    expect(result.code).toBe(EXIT_INGESTION);
    expect(result.stderr).toContain('private address');
    expect(result.stdout).toBe('');
  });
});

describe('dual surface: pack create', () => {
  it('`pack create` behaves identically to `create`', async () => {
    const buildPack = fakeBuildPack();
    const dbPath = join(packs.packsDir, 'gamma-pack', DB_FILENAME);

    const result = await runCli(['pack', 'create', '--pack', 'gamma-pack', '--seeds', SEED_A], {
      packsDir: packs.packsDir,
      buildPack,
    });

    expect(result.code).toBe(EXIT_OK);
    expect(buildPack).toHaveBeenCalledWith(expect.objectContaining({ seeds: [SEED_A], dbPath }));
    expect(parseStdout(result)).toEqual(expectedBuildCounts('gamma-pack', dbPath));
  });
});

describe('research-sources', () => {
  it('reports newly discovered URLs from the seam (exit 0)', async () => {
    const discovered = [SEED_B, 'https://en.wikipedia.org/wiki/Analytical_Engine'];
    const discoverSources = vi.fn(async () => discovered);

    const result = await runCli(['research-sources', '--seeds', SEED_A], {
      packsDir: packs.packsDir,
      discoverSources,
    });

    expect(result.code).toBe(EXIT_OK);
    expect(discoverSources).toHaveBeenCalledWith({
      seeds: [SEED_A],
      maxDepth: INGEST_DEFAULTS.maxDepth,
      maxArticles: INGEST_DEFAULTS.maxArticles,
    });
    expect(parseStdout(result)).toEqual({
      seeds: [SEED_A],
      discovered,
      count: discovered.length,
    });
  });

  it('passes multiple seeds and honours --max-depth / --max-articles', async () => {
    const discoverSources = vi.fn(async () => []);

    await runCli(
      ['research-sources', '--seeds', SEED_A, SEED_B, '--max-depth', '2', '--max-articles', '5'],
      { packsDir: packs.packsDir, discoverSources },
    );

    expect(discoverSources).toHaveBeenCalledWith({
      seeds: [SEED_A, SEED_B],
      maxDepth: 2,
      maxArticles: 5,
    });
  });

  it('maps a discovery failure to exit 7', async () => {
    const discoverSources = vi.fn(async () => {
      const err = new Error('fetch failed: 503');
      err.name = 'FetchError';
      throw err;
    });

    const result = await runCli(['research-sources', '--seeds', SEED_A], {
      packsDir: packs.packsDir,
      discoverSources,
    });

    expect(result.code).toBe(EXIT_INGESTION);
    expect(result.stdout).toBe('');
  });
});

// Sanity: the canned-counts helper matches the documented example cardinalities.
describe('fixture sanity', () => {
  it('encodes the documented bounded-count fields', () => {
    expect(Object.keys(BUILD_COUNTS)).toEqual([
      'articles',
      'sections',
      'chunks',
      'entities',
      'relationships',
      'links',
      'skipped',
    ]);
  });
});
