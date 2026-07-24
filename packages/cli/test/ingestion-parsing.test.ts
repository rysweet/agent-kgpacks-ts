// packages/cli/test/ingestion-parsing.test.ts
//
// Argument-parsing + usage contract for the Phase-2 INGESTION/EVAL subcommands.
// Usage failures exit 2 and write a command-specific diagnostic to stderr (never
// stdout); `--help` exits 0 and writes usage to stdout. The stderr substring
// assertions pin the *intended* diagnostic, so these tests fail meaningfully until
// each command is wired (an "unknown command" error carries none of them).

import { describe, expect, it } from 'vitest';

import { EXIT_OK, EXIT_USAGE } from '../src/exit-codes.js';
import { parseStdout, runCli } from './helpers/run-cli.js';

const SEED = 'https://en.wikipedia.org/wiki/Ada_Lovelace';

describe('Phase-2 usage / parse errors (exit 2)', () => {
  it.each([
    ['create missing --pack', ['create', '--seeds', SEED], /--pack/],
    ['create missing seed source', ['create', '--pack', 'ada'], /seed|--config/i],
    [
      'create non-integer --max-depth',
      ['create', '--pack', 'ada', '--seeds', SEED, '--max-depth', 'abc'],
      /max-depth/,
    ],
    [
      'create zero --max-articles',
      ['create', '--pack', 'ada', '--seeds', SEED, '--max-articles', '0'],
      /max-articles/,
    ],
    [
      'update missing fresh inputs',
      ['update', '--base', '/tmp/base'],
      /--delta.*--output.*--version/s,
    ],
    ['research-sources missing --seeds', ['research-sources'], /--seeds/],
    ['pack eval missing --pack', ['pack', 'eval'], /--pack/],
  ])('exits 2 with a targeted diagnostic: %s', async (_label, argv, pattern) => {
    const result = await runCli(argv as string[]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(pattern as RegExp);
  });

  it('continues to accept global --packs-dir after a subcommand', async () => {
    const result = await runCli(['status', '--packs-dir', '/tmp/kgpacks-after-command']);
    expect(result.code).toBe(EXIT_OK);
    expect(parseStdout(result)).toMatchObject({ packsDir: '/tmp/kgpacks-after-command' });
  });

  it('does not rewrite --version when update is an argument to another command', async () => {
    const result = await runCli(['query', 'update', 'question', '--version']);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).not.toContain('target-version');
  });
});
