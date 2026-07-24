// packages/cli/test/commands.test.ts
//
// Command behavior and the exit-code contract for the RUNTIME commands, driven
// against an on-disk mock packs directory. `query` uses an injected runner so no
// database/embedding runtime is loaded; every other command exercises the real
// `@kgpacks/packs` APIs.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueryRunner } from '../src/query-runner.js';
import { EXIT_OK, EXIT_PACK_NOT_FOUND, EXIT_QUERY, EXIT_VALIDATION } from '../src/exit-codes.js';
import { ALPHA_MANIFEST, makeMockPacks, type MockPacks } from './helpers/mock-packs.js';
import { parseStdout, runCli } from './helpers/run-cli.js';

let packs: MockPacks;
const echoRunner: QueryRunner = async (input) => ({
  pack: input.packName,
  question: input.question,
  k: input.k,
  results: [{ id: '1', score: 0.5, content: 'hit', mode: input.mode }],
});

beforeEach(() => {
  packs = makeMockPacks();
});
afterEach(() => {
  packs.cleanup();
});

function cli(argv: string[], runQuery: QueryRunner = echoRunner) {
  return runCli(argv, { packsDir: packs.packsDir, runQuery });
}

describe('status', () => {
  it('reports the resolved packs directory and per-pack db presence', async () => {
    const result = await cli(['status']);
    expect(result.code).toBe(EXIT_OK);
    expect(parseStdout(result)).toEqual({
      packsDir: packs.packsDir,
      count: 2,
      packs: [
        { name: 'alpha-pack', version: '1.2.0', dbPresent: true },
        { name: 'beta-pack', version: '0.3.1', dbPresent: false },
      ],
    });
  });

  it('reports an empty list (exit 0) for a missing packs directory', async () => {
    const result = await runCli(['status'], { packsDir: '/no/such/dir', runQuery: echoRunner });
    expect(result.code).toBe(EXIT_OK);
    expect(parseStdout(result)).toEqual({ packsDir: '/no/such/dir', count: 0, packs: [] });
  });
});

describe('pack list', () => {
  it('lists installed packs sorted by name', async () => {
    const result = await cli(['pack', 'list']);
    expect(result.code).toBe(EXIT_OK);
    expect(parseStdout(result)).toEqual([
      { name: 'alpha-pack', version: '1.2.0', description: 'Alpha knowledge pack' },
      { name: 'beta-pack', version: '0.3.1', description: '' },
    ]);
  });
});

describe('pack info', () => {
  it('prints the full manifest for a known pack', async () => {
    const result = await cli(['pack', 'info', 'alpha-pack']);
    expect(result.code).toBe(EXIT_OK);
    expect(parseStdout(result)).toEqual(ALPHA_MANIFEST);
  });

  it('exits 3 for an unknown pack', async () => {
    const result = await cli(['pack', 'info', 'ghost-pack']);
    expect(result.code).toBe(EXIT_PACK_NOT_FOUND);
    expect(result.stderr).toContain('pack not found: ghost-pack');
    expect(result.stdout).toBe('');
  });

  it('exits 4 for an invalid pack name', async () => {
    const result = await cli(['pack', 'info', 'bad/name']);
    expect(result.code).toBe(EXIT_VALIDATION);
  });
});

describe('pack validate', () => {
  it('confirms a valid manifest (exit 0)', async () => {
    const result = await cli(['pack', 'validate', 'alpha-pack']);
    expect(result.code).toBe(EXIT_OK);
    expect(parseStdout(result)).toEqual({ valid: true, name: 'alpha-pack', version: '1.2.0' });
  });

  it('exits 4 for a manifest that fails validation', async () => {
    const result = await cli(['pack', 'validate', 'broken-pack']);
    expect(result.code).toBe(EXIT_VALIDATION);
    expect(result.stderr).toContain('invalid version');
  });

  it('exits 4 for an unsupported manifest schema', async () => {
    writeFileSync(
      join(packs.packsDir, 'alpha-pack', 'manifest.json'),
      `${JSON.stringify({ ...ALPHA_MANIFEST, schemaVersion: '999' }, null, 2)}\n`,
    );
    const result = await cli(['pack', 'validate', 'alpha-pack']);
    expect(result.code).toBe(EXIT_VALIDATION);
    expect(result.stderr).toContain('unsupported manifest schema "999"');
  });

  it('exits 3 for a missing pack', async () => {
    const result = await cli(['pack', 'validate', 'ghost-pack']);
    expect(result.code).toBe(EXIT_PACK_NOT_FOUND);
  });
});

describe('pack remove', () => {
  it('removes a pack (exit 0) and is then absent from status', async () => {
    const removed = await cli(['pack', 'remove', 'beta-pack']);
    expect(removed.code).toBe(EXIT_OK);
    expect(parseStdout(removed)).toEqual({ removed: 'beta-pack' });

    const status = await cli(['status']);
    const names = (parseStdout(status) as { packs: { name: string }[] }).packs.map((p) => p.name);
    expect(names).not.toContain('beta-pack');
  });

  it('exits 3 when removing a pack that is not installed', async () => {
    const result = await cli(['pack', 'remove', 'ghost-pack']);
    expect(result.code).toBe(EXIT_PACK_NOT_FOUND);
  });
});

describe('query', () => {
  it('delegates to the runner with parsed -k/--mode and prints the result', async () => {
    const runQuery = vi.fn<QueryRunner>(echoRunner);
    const result = await cli(
      ['query', 'alpha-pack', 'what is alpha?', '-k', '3', '--mode', 'hybrid'],
      runQuery,
    );
    expect(result.code).toBe(EXIT_OK);
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery).toHaveBeenCalledWith({
      packName: 'alpha-pack',
      dbPath: `${packs.packsDir}/alpha-pack/pack.db`,
      question: 'what is alpha?',
      k: 3,
      mode: 'hybrid',
    });
    expect(parseStdout(result)).toMatchObject({
      pack: 'alpha-pack',
      question: 'what is alpha?',
      k: 3,
    });
  });

  it('applies the default -k=5 and --mode=vector', async () => {
    const runQuery = vi.fn<QueryRunner>(echoRunner);
    await cli(['query', 'alpha-pack', 'q'], runQuery);
    expect(runQuery).toHaveBeenCalledWith(expect.objectContaining({ k: 5, mode: 'vector' }));
  });

  it('exits 6 when the pack has no database, without calling the runner', async () => {
    const runQuery = vi.fn<QueryRunner>(echoRunner);
    const result = await cli(['query', 'beta-pack', 'q'], runQuery);
    expect(result.code).toBe(EXIT_QUERY);
    expect(result.stderr).toContain('Database not found at');
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('exits 3 for an unknown pack', async () => {
    const result = await cli(['query', 'ghost-pack', 'q']);
    expect(result.code).toBe(EXIT_PACK_NOT_FOUND);
  });

  it('propagates a runner failure as exit 6 (QueryError)', async () => {
    const failing: QueryRunner = async () => {
      const { QueryError } = await import('@kgpacks/query');
      throw new QueryError('retrieval blew up');
    };
    const result = await cli(['query', 'alpha-pack', 'q'], failing);
    expect(result.code).toBe(EXIT_QUERY);
    expect(result.stderr).toContain('retrieval blew up');
  });
});
