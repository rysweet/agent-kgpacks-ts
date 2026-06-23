// packages/cli/test/parsing.test.ts
//
// Argument-parsing contract and the usage/exit-code surface. Usage failures all
// exit 2 and write their diagnostic to stderr (never stdout); help and version
// exit 0.

import { describe, expect, it } from 'vitest';

import { CLI_VERSION } from '../src/constants.js';
import { EXIT_OK, EXIT_USAGE } from '../src/exit-codes.js';
import { runCli } from './helpers/run-cli.js';

describe('usage and parse errors (exit 2)', () => {
  it.each([
    ['unknown command', ['bogus']],
    ['pack with no subcommand', ['pack']],
    ['query missing both positionals', ['query']],
    ['query missing question', ['query', 'alpha-pack']],
    ['query invalid --mode choice', ['query', 'a', 'q', '--mode', 'nope']],
    ['query non-integer -k', ['query', 'a', 'q', '-k', 'abc']],
    ['query zero -k', ['query', 'a', 'q', '-k', '0']],
    ['pack info missing positional', ['pack', 'info']],
    ['pack install missing positional', ['pack', 'install']],
    ['unknown option', ['query', 'a', 'q', '--nope']],
  ])('exits 2 and writes to stderr: %s', async (_label, argv) => {
    const result = await runCli(argv);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).not.toBe('');
    expect(result.stdout).toBe('');
  });
});

describe('help and version (exit 0)', () => {
  it.each([
    ['root --help', ['--help']],
    ['root -h', ['-h']],
    ['query --help', ['query', '--help']],
    ['pack --help', ['pack', '--help']],
    ['pack install --help', ['pack', 'install', '--help']],
  ])('exits 0 and writes help to stdout: %s', async (_label, argv) => {
    const result = await runCli(argv);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/Usage: wikigr/);
  });

  it('prints the version and exits 0', async () => {
    const result = await runCli(['--version']);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.trim()).toBe(CLI_VERSION);
  });

  it('prints root help for a bare invocation and exits 0', async () => {
    const result = await runCli([]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/Usage: wikigr \[options\] \[command\]/);
  });
});
