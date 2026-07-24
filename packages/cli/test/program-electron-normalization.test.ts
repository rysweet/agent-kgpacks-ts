import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../src/program.js';

const originalArgv = process.argv;
const electronProcess = process as NodeJS.Process & { defaultApp?: boolean };
const originalDefaultApp = Object.getOwnPropertyDescriptor(process, 'defaultApp');
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
  if (originalDefaultApp) Object.defineProperty(process, 'defaultApp', originalDefaultApp);
  else delete electronProcess.defaultApp;
});

function setDefaultApp(defaultApp: boolean): void {
  Object.defineProperty(process, 'defaultApp', {
    configurable: true,
    value: defaultApp,
  });
}

describe.each(['parse', 'parseAsync'] as const)('%s Electron normalization', (method) => {
  it.each([
    ['explicit packaged argv', 'explicit', false],
    ['default packaged argv', 'default', false],
    ['explicit default-app argv', 'explicit', true],
    ['default default-app argv', 'default', true],
  ] as const)('preserves %s', async (_label, argvKind, defaultApp) => {
    setDefaultApp(defaultApp);
    const prefix = defaultApp ? [process.execPath, '/tmp/wikigr.js'] : [process.execPath];
    const argv = [...prefix, ...userArgv];
    if (argvKind === 'default') process.argv = argv;
    const program = buildProgram();
    const update = program.commands.find((command) => command.name() === 'update');
    if (!update) throw new Error('update command is not registered');
    const action = vi.fn();
    update.action(action);

    const result = program[method](argvKind === 'explicit' ? argv : undefined, {
      from: 'electron',
    });
    if (method === 'parseAsync') await result;

    expect(action).toHaveBeenCalledOnce();
    expect(update.opts()).toMatchObject({ targetVersion: '2.0.0' });
  });
});
