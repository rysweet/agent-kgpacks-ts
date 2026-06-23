// packages/cli/test/ingestion-help-snapshots.test.ts
//
// Golden help/usage snapshots for the Phase-2 INGESTION/EVAL subcommands, kept in
// their own file so the Phase-1 per-command goldens in `help-snapshots.test.ts`
// stay byte-identical.
//
// NOTE on the `usage` guard: commander's `--help` short-circuits to the *nearest
// known* command, so before a command is registered `wikigr create --help` prints
// the ROOT help (exit 0) and `wikigr pack create --help` prints the `pack`-group
// help. Asserting the command-specific `Usage:` line therefore fails until the
// command actually exists — and, crucially, stops a bogus parent-help golden from
// being written. The trailing assertions lock the new commands into the aggregate
// `root` / `pack` listings.

import { describe, expect, it } from 'vitest';

import { runCli } from './helpers/run-cli.js';

describe('Phase-2 help/usage golden snapshots', () => {
  it.each([
    ['create', ['create', '--help'], 'Usage: wikigr create'],
    ['update', ['update', '--help'], 'Usage: wikigr update'],
    ['research-sources', ['research-sources', '--help'], 'Usage: wikigr research-sources'],
    ['pack create', ['pack', 'create', '--help'], 'Usage: wikigr pack create'],
    ['pack eval', ['pack', 'eval', '--help'], 'Usage: wikigr pack eval'],
    ['pack update', ['pack', 'update', '--help'], 'Usage: wikigr pack update'],
  ])('matches the %s help snapshot', async (label, argv, usage) => {
    const result = await runCli(argv as string[]);
    expect(result.code).toBe(0);
    // Guard: only the command's OWN help should reach the snapshot.
    expect(result.stdout).toContain(usage as string);
    expect(result.stdout).toMatchSnapshot(label as string);
  });
});

describe('Phase-2 commands appear in the aggregate help listings', () => {
  it('lists create / update / research-sources under root help', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('create');
    expect(result.stdout).toContain('update');
    expect(result.stdout).toContain('research-sources');
  });

  it('lists create / eval / update under the `pack` group help', async () => {
    const result = await runCli(['pack', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('create');
    expect(result.stdout).toContain('eval');
    expect(result.stdout).toContain('update');
  });
});
