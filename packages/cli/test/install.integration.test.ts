// packages/cli/test/install.integration.test.ts
//
// End-to-end integration against a fixture pack: build a real `.tar.gz`, install
// it through the CLI, then exercise the full management lifecycle (list → info →
// validate → status → query → remove) over the freshly installed pack. This is
// the cross-command contract the unit tests above only touch piecewise.

import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QueryRunner } from '../src/query-runner.js';
import { EXIT_INSTALL, EXIT_OK, EXIT_PACK_NOT_FOUND } from '../src/exit-codes.js';
import { parseStdout, runCli } from './helpers/run-cli.js';
import { makeTarGz } from './helpers/tar.js';

const GAMMA_MANIFEST = {
  name: 'gamma-pack',
  version: '2.0.0',
  description: 'Gamma knowledge pack',
  graph_stats: { articles: 2, entities: 3, relationships: 1, size_mb: 0.1 },
};

let base: string;
let packsDir: string;
let archive: string;

const runQuery: QueryRunner = async (input) => ({
  pack: input.packName,
  question: input.question,
  k: input.k,
  results: [],
});

function cli(argv: string[]) {
  return runCli(argv, { packsDir, runQuery });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kgpacks-cli-int-'));
  packsDir = join(base, 'packs');
  archive = join(base, 'gamma-pack.tar.gz');
  writeFileSync(
    archive,
    makeTarGz([
      { name: 'manifest.json', content: JSON.stringify(GAMMA_MANIFEST, null, 2) + '\n' },
      { name: 'pack.db', content: 'fixture database bytes' },
    ]),
  );
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('pack install → manage → remove lifecycle', () => {
  it('installs a fixture pack from a .tar.gz archive', async () => {
    const result = await cli(['pack', 'install', archive]);
    expect(result.code).toBe(EXIT_OK);
    expect(parseStdout(result)).toEqual({
      name: 'gamma-pack',
      version: '2.0.0',
      path: join(packsDir, 'gamma-pack'),
    });
    expect(existsSync(join(packsDir, 'gamma-pack', 'manifest.json'))).toBe(true);
    expect(existsSync(join(packsDir, 'gamma-pack', 'pack.db'))).toBe(true);
  });

  it('rejects re-installing an already-present pack (exit 5)', async () => {
    expect((await cli(['pack', 'install', archive])).code).toBe(EXIT_OK);
    const again = await cli(['pack', 'install', archive]);
    expect(again.code).toBe(EXIT_INSTALL);
    expect(again.stderr).toContain('already installed');
  });

  it('exits 5 for a missing archive', async () => {
    const result = await cli(['pack', 'install', join(base, 'nope.tar.gz')]);
    expect(result.code).toBe(EXIT_INSTALL);
  });

  it('surfaces the installed pack through list, info, validate and status', async () => {
    await cli(['pack', 'install', archive]);

    const list = await cli(['pack', 'list']);
    expect(parseStdout(list)).toEqual([
      { name: 'gamma-pack', version: '2.0.0', description: 'Gamma knowledge pack' },
    ]);

    const info = await cli(['pack', 'info', 'gamma-pack']);
    expect(parseStdout(info)).toEqual(GAMMA_MANIFEST);

    const validate = await cli(['pack', 'validate', 'gamma-pack']);
    expect(parseStdout(validate)).toEqual({ valid: true, name: 'gamma-pack', version: '2.0.0' });

    const status = await cli(['status']);
    expect(parseStdout(status)).toEqual({
      packsDir,
      count: 1,
      packs: [{ name: 'gamma-pack', version: '2.0.0', dbPresent: true }],
    });
  });

  it('queries the installed pack (database present) via the runner', async () => {
    await cli(['pack', 'install', archive]);
    const result = await cli(['query', 'gamma-pack', 'what is gamma?']);
    expect(result.code).toBe(EXIT_OK);
    expect(parseStdout(result)).toMatchObject({ pack: 'gamma-pack', question: 'what is gamma?' });
  });

  it('removes the installed pack and leaves the registry empty', async () => {
    await cli(['pack', 'install', archive]);

    const removed = await cli(['pack', 'remove', 'gamma-pack']);
    expect(removed.code).toBe(EXIT_OK);
    expect(parseStdout(removed)).toEqual({ removed: 'gamma-pack' });
    expect(existsSync(join(packsDir, 'gamma-pack'))).toBe(false);

    const status = await cli(['status']);
    expect(parseStdout(status)).toEqual({ packsDir, count: 0, packs: [] });

    expect((await cli(['pack', 'remove', 'gamma-pack'])).code).toBe(EXIT_PACK_NOT_FOUND);
  });
});
