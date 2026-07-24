import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../src/program.js';

type ParseFrom = 'node' | 'user';

const originalArgv = process.argv;
const originalExecArgv = process.execArgv;
const userArgv = [
  'update',
  '--base',
  '/tmp/base',
  '--delta',
  '/tmp/delta.ndjson',
  '--output',
  '/tmp/output',
  '--version',
  '2.0.0',
];

afterEach(() => {
  process.argv = originalArgv;
  process.execArgv = originalExecArgv;
});

function explicitArgv(from: ParseFrom): string[] {
  return from === 'user' ? userArgv : [process.execPath, '/tmp/wikigr.js', ...userArgv];
}

describe.each(['parse', 'parseAsync'] as const)('%s invocation normalization', (method) => {
  it.each([
    ['explicit user argv', 'explicit', 'user'],
    ['explicit node argv', 'explicit', 'node'],
    ['default user argv', 'default', 'user'],
    ['default node argv', 'default', 'node'],
  ] as const)('preserves %s and --version scoping', async (_label, argvKind, from) => {
    const program = buildProgram();
    const update = program.commands.find((command) => command.name() === 'update');
    if (!update) throw new Error('update command is not registered');
    const action = vi.fn();
    update.action(action);
    const argv = explicitArgv(from);
    if (argvKind === 'default') process.argv = argv;

    let failure: unknown;
    try {
      const result = program[method](argvKind === 'explicit' ? argv : undefined, { from });
      if (method === 'parseAsync') await result;
    } catch (error) {
      failure = error;
    }

    expect(
      failure,
      `${method} must normalize without changing Commander ${from} semantics`,
    ).toBeUndefined();
    expect(action).toHaveBeenCalledOnce();
    expect(update.opts()).toMatchObject({ targetVersion: '2.0.0' });
  });

  it.each([
    ['default process argv', false],
    ['explicit process argv', true],
  ] as const)('normalizes %s when parse options are omitted', async (_label, explicit) => {
    process.argv = explicitArgv('node');
    const program = buildProgram();
    const update = program.commands.find((command) => command.name() === 'update');
    if (!update) throw new Error('update command is not registered');
    const action = vi.fn();
    update.action(action);

    const result = program[method](explicit ? process.argv : undefined);
    if (method === 'parseAsync') await result;

    expect(action).toHaveBeenCalledOnce();
    expect(update.opts()).toMatchObject({ targetVersion: '2.0.0' });
  });

  it.each([undefined, {}] as const)(
    'normalizes auto-detected eval argv with parse options %s',
    async (parseOptions) => {
      process.argv = [process.execPath, ...userArgv];
      process.execArgv = ['--eval', 'void 0'];
      const program = buildProgram();
      const update = program.commands.find((command) => command.name() === 'update');
      if (!update) throw new Error('update command is not registered');
      const action = vi.fn();
      update.action(action);

      const result = program[method](undefined, parseOptions);
      if (method === 'parseAsync') await result;

      expect(action).toHaveBeenCalledOnce();
      expect(update.opts()).toMatchObject({ targetVersion: '2.0.0' });
    },
  );
});
