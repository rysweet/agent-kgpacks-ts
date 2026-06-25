// packages/cli/test/eval-command.test.ts
//
// Behaviour + exit-code contract for `pack eval` — running `@kgpacks/eval` over an
// installed pack. The eval pipeline (judge transport, synthesis agent, retriever)
// is never loaded: the command delegates to an injected `evalPack` seam, so the
// suite runs fully offline. Defines the contract the implementation must satisfy.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXIT_OK, EXIT_PACK_NOT_FOUND } from '../src/exit-codes.js';
import { makeMockPacks, type MockPacks } from './helpers/mock-packs.js';
import { EVAL_DEFAULTS, makeEvalReport } from './helpers/phase2.js';
import { parseStdout, runCli } from './helpers/run-cli.js';

// New write-side exit code (mirrors EXIT_EVAL in src/exit-codes.ts).
const EXIT_EVAL = 8;

let packs: MockPacks;

/** An `evalPack` seam double returning a canned `EvalReport`. */
function fakeEvalPack() {
  return vi.fn(async () => makeEvalReport());
}

beforeEach(() => {
  packs = makeMockPacks();
});
afterEach(() => {
  packs.cleanup();
});

describe('pack eval', () => {
  it('runs the eval seam over an existing pack and prints the report (exit 0)', async () => {
    const evalPack = fakeEvalPack();

    const result = await runCli(['pack', 'eval', '--pack', 'alpha-pack'], {
      packsDir: packs.packsDir,
      evalPack,
    });

    expect(result.code).toBe(EXIT_OK);
    expect(evalPack).toHaveBeenCalledTimes(1);
    expect(parseStdout(result)).toEqual(makeEvalReport());
  });

  it('passes the default eval knobs (full sample, per-pack 3, pinned judge model)', async () => {
    const evalPack = fakeEvalPack();

    await runCli(['pack', 'eval', '--pack', 'alpha-pack'], {
      packsDir: packs.packsDir,
      evalPack,
    });

    expect(evalPack).toHaveBeenCalledWith(
      expect.objectContaining({
        packDir: join(packs.packsDir, 'alpha-pack'),
        packId: 'alpha-pack',
        sample: EVAL_DEFAULTS.sample,
        perPack: EVAL_DEFAULTS.perPack,
        judgeModel: EVAL_DEFAULTS.judgeModel,
        questionsDir: packs.packsDir,
      }),
    );
  });

  it('honours --sample / --per-pack / --judge-model / --questions overrides', async () => {
    const evalPack = fakeEvalPack();

    await runCli(
      [
        'pack',
        'eval',
        '--pack',
        'alpha-pack',
        '--sample',
        'stratified',
        '--per-pack',
        '5',
        '--judge-model',
        'my-judge-1',
        '--questions',
        '/tmp/questions',
      ],
      { packsDir: packs.packsDir, evalPack },
    );

    expect(evalPack).toHaveBeenCalledWith(
      expect.objectContaining({
        packId: 'alpha-pack',
        sample: 'stratified',
        perPack: 5,
        judgeModel: 'my-judge-1',
        questionsDir: '/tmp/questions',
      }),
    );
  });

  it('exits 3 for an unknown pack, without calling the seam', async () => {
    const evalPack = fakeEvalPack();

    const result = await runCli(['pack', 'eval', '--pack', 'ghost-pack'], {
      packsDir: packs.packsDir,
      evalPack,
    });

    expect(result.code).toBe(EXIT_PACK_NOT_FOUND);
    expect(evalPack).not.toHaveBeenCalled();
  });

  it('exits 3 when the pack directory exists but has no pack.db, without calling the seam', async () => {
    // beta-pack is a manifest-only pack (no database). eval must NOT open-or-create
    // an empty pack.db nor invoke the heavy seam — mirroring the `query` guard.
    const evalPack = fakeEvalPack();

    const result = await runCli(['pack', 'eval', '--pack', 'beta-pack'], {
      packsDir: packs.packsDir,
      evalPack,
    });

    expect(result.code).toBe(EXIT_PACK_NOT_FOUND);
    expect(result.stderr).toContain('Database not found');
    expect(evalPack).not.toHaveBeenCalled();
    expect(existsSync(join(packs.packsDir, 'beta-pack', 'pack.db'))).toBe(false);
  });

  it('maps an EvalError to exit 8 (by name)', async () => {
    const evalPack = vi.fn(async () => {
      const err = new Error('no eval questions for pack');
      err.name = 'EvalError';
      throw err;
    });

    const result = await runCli(['pack', 'eval', '--pack', 'alpha-pack'], {
      packsDir: packs.packsDir,
      evalPack,
    });

    expect(result.code).toBe(EXIT_EVAL);
    expect(result.stderr).toContain('no eval questions');
    expect(result.stdout).toBe('');
  });

  it('rejects an invalid --sample choice with a usage error (exit 2)', async () => {
    const result = await runCli(['pack', 'eval', '--pack', 'alpha-pack', '--sample', 'bogus'], {
      packsDir: packs.packsDir,
      evalPack: fakeEvalPack(),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
  });
});
