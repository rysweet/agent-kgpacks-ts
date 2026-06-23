// packages/cli/test/help-snapshots.test.ts
//
// Golden snapshots of the CLI help/usage surface. Because no upstream help text is
// available in-repo and the binary keeps the upstream name `wikigr`, these
// goldens are authored here and lock the command surface (names, flags,
// descriptions, defaults) against accidental drift.

import { describe, expect, it } from 'vitest';

import { runCli } from './helpers/run-cli.js';

describe('help/usage golden snapshots', () => {
  it.each([
    ['root', ['--help']],
    ['query', ['query', '--help']],
    ['status', ['status', '--help']],
    ['pack', ['pack', '--help']],
    ['pack install', ['pack', 'install', '--help']],
    ['pack list', ['pack', 'list', '--help']],
    ['pack info', ['pack', 'info', '--help']],
    ['pack validate', ['pack', 'validate', '--help']],
    ['pack remove', ['pack', 'remove', '--help']],
  ])('matches the %s help snapshot', async (label, argv) => {
    const result = await runCli(argv);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatchSnapshot(label);
  });

  it('matches the `pack` no-subcommand usage snapshot (exit 2)', async () => {
    const result = await runCli(['pack']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatchSnapshot('pack-no-subcommand');
  });
});
