import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../src/program.js';
import { EXIT_OK, EXIT_USAGE } from '../src/exit-codes.js';
import { createBufferedIo } from '../src/io.js';
import { parseStdout, runCli } from './helpers/run-cli.js';

describe.each([
  { name: 'update', command: ['update'] },
  { name: 'pack update', command: ['pack', 'update'] },
])('wikigr $name', ({ command }) => {
  let dir: string;
  let base: string;
  let delta: string;
  let output: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kgpacks-update-cli-'));
    base = join(dir, 'base');
    delta = join(dir, 'delta.ndjson');
    output = join(dir, 'output');
    mkdirSync(base);
    writeFileSync(delta, '{}\n');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs a fresh immutable update with explicit base, delta, output, and version', async () => {
    const updateKnowledgePack = vi.fn(async () => ({
      packId: 'cve',
      version: '2.0.0',
      buildId: 'a'.repeat(64),
      deltaId: 'b'.repeat(64),
      added: 1,
      modified: 1,
      unchanged: 1,
      noop: false,
      output,
    }));

    const result = await runCli(
      [...command, '--base', base, '--delta', delta, '--output', output, '--version', '2.0.0'],
      { updateKnowledgePack },
    );

    expect(result.code).toBe(EXIT_OK);
    expect(updateKnowledgePack).toHaveBeenCalledWith({
      base,
      delta,
      output,
      version: '2.0.0',
      workDir: undefined,
    });

    expect(parseStdout(result)).toMatchObject({
      packId: 'cve',
      version: '2.0.0',
      added: 1,
      modified: 1,
      unchanged: 1,
    });
  });

  describe('update --version normalization scope', () => {
    it.each([
      ['the root command', ['--version']],
      ['an unrelated command', ['status', '--version']],
    ])('does not rewrite --version for %s', async (_label, argv) => {
      const io = createBufferedIo();
      const updateKnowledgePack = vi.fn();
      const program = buildProgram({ updateKnowledgePack, io });

      await expect(program.parseAsync(argv, { from: 'user' })).rejects.toMatchObject({
        code: 'commander.version',
        exitCode: 0,
      });
      expect(io.stdout()).not.toContain('target-version');
      expect(updateKnowledgePack).not.toHaveBeenCalled();
    });
  });

  it('scopes --version to update when parsing the program directly', async () => {
    const updateKnowledgePack = vi.fn(async () => ({
      packId: 'cve',
      version: '2.0.0',
      buildId: 'a'.repeat(64),
      deltaId: 'b'.repeat(64),
      added: 1,
      modified: 0,
      unchanged: 0,
      noop: false,
      output,
    }));
    const program = buildProgram({ updateKnowledgePack, io: createBufferedIo() });

    await program.parseAsync(
      [...command, '--base', base, '--delta', delta, '--output', output, '--version', '2.0.0'],
      { from: 'user' },
    );

    expect(updateKnowledgePack).toHaveBeenCalledWith(expect.objectContaining({ version: '2.0.0' }));
  });

  it.each([
    ['user', { from: 'user' as const }, 0, false],
    ['node', { from: 'node' as const }, 2, false],
    ['default', undefined, 2, false],
    ['electron default app', { from: 'electron' as const }, 2, true],
    ['electron packaged app', { from: 'electron' as const }, 1, false],
  ])(
    'normalizes --version in Commander %s mode after the correct argv prefix',
    async (_mode, parseOptions, prefixLength, defaultApp) => {
      const updateKnowledgePack = vi.fn(async () => ({
        packId: 'cve',
        version: '2.0.0',
        buildId: 'a'.repeat(64),
        deltaId: 'b'.repeat(64),
        added: 1,
        modified: 0,
        unchanged: 0,
        noop: false,
        output,
      }));
      const program = buildProgram({ updateKnowledgePack, io: createBufferedIo() });
      const prefix = prefixLength === 2 ? ['runtime', 'script'] : prefixLength === 1 ? ['app'] : [];
      const nodeProcess = process as NodeJS.Process & { defaultApp?: boolean };
      const previous = Object.getOwnPropertyDescriptor(process, 'defaultApp');
      Object.defineProperty(nodeProcess, 'defaultApp', {
        value: defaultApp,
        configurable: true,
        writable: true,
      });
      try {
        const argv = [
          ...prefix,
          ...command,
          '--base',
          base,
          '--delta',
          delta,
          '--output',
          output,
          '--version=2.0.0',
        ];
        if (parseOptions) await program.parseAsync(argv, parseOptions);
        else await program.parseAsync(argv);
      } finally {
        if (previous) Object.defineProperty(nodeProcess, 'defaultApp', previous);
        else delete nodeProcess.defaultApp;
      }

      expect(updateKnowledgePack).toHaveBeenCalledWith(
        expect.objectContaining({ version: '2.0.0' }),
      );
    },
  );

  it('treats omitted argv as process.argv in default/node mode regardless of parse options', async () => {
    const updateKnowledgePack = vi.fn(async () => ({
      packId: 'cve',
      version: '2.0.0',
      buildId: 'a'.repeat(64),
      deltaId: 'b'.repeat(64),
      added: 1,
      modified: 0,
      unchanged: 0,
      noop: false,
      output,
    }));
    const program = buildProgram({ updateKnowledgePack, io: createBufferedIo() });
    const previousArgv = process.argv;
    process.argv = [
      'runtime',
      'script',
      ...command,
      '--base',
      base,
      '--delta',
      delta,
      '--output',
      output,
      '--version',
      '2.0.0',
    ];
    try {
      await program.parseAsync(undefined, { from: 'user' });
    } finally {
      process.argv = previousArgv;
    }
    expect(updateKnowledgePack).toHaveBeenCalledWith(expect.objectContaining({ version: '2.0.0' }));
  });

  it.each([
    ['before the top-level command', ['--packs-dir', '$dir', ...command]],
    ['equals form before the top-level command', ['--packs-dir=$dir', ...command]],
    [
      'between pack and update',
      command[0] === 'pack' ? ['pack', '--packs-dir', '$dir', 'update'] : [...command],
    ],
  ])('normalizes update --version with global --packs-dir %s', async (_label, commandArgs) => {
    const updateKnowledgePack = vi.fn(async () => ({
      packId: 'cve',
      version: '2.0.0',
      buildId: 'a'.repeat(64),
      deltaId: 'b'.repeat(64),
      added: 1,
      modified: 0,
      unchanged: 0,
      noop: false,
      output,
    }));
    const program = buildProgram({ updateKnowledgePack, io: createBufferedIo() });
    const argv = commandArgs
      .map((arg) => arg.replace('$dir', dir))
      .concat(['--base', base, '--delta', delta, '--output', output, '--version', '2.0.0']);

    await program.parseAsync(argv, { from: 'user' });
    expect(updateKnowledgePack).toHaveBeenCalledWith(expect.objectContaining({ version: '2.0.0' }));
  });

  it('runs resume mode with only the work directory', async () => {
    const workDir = join(dir, 'output.work');
    const updateKnowledgePack = vi.fn(async () => ({
      packId: 'cve',
      version: '2.0.0',
      buildId: 'a'.repeat(64),
      deltaId: 'b'.repeat(64),
      added: 1,
      modified: 1,
      unchanged: 1,
      noop: false,
      output,
    }));

    const result = await runCli([...command, '--resume', workDir], { updateKnowledgePack });

    expect(result.code).toBe(EXIT_OK);
    expect(updateKnowledgePack).toHaveBeenCalledWith({ resume: workDir });
  });

  it.each([
    ['missing required fresh options', ['--base', '$base'], /--delta.*--output.*--version/s],
    [
      'mixed fresh and resume modes',
      ['--resume', '$work', '--base', '$base'],
      /mutually exclusive/i,
    ],
    [
      'legacy seed-based update flags',
      ['--pack', 'cve', '--seeds', 'https://example.test/cve'],
      /unknown option|--base/i,
    ],
  ])('rejects %s', async (_name, args, expected) => {
    const updateKnowledgePack = vi.fn();
    const resolvedArgs = args.map((arg) =>
      arg === '$base' ? base : arg === '$work' ? join(dir, 'work') : arg,
    );
    const result = await runCli([...command, ...resolvedArgs], { updateKnowledgePack });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(expected);
    expect(updateKnowledgePack).not.toHaveBeenCalled();
  });
});
