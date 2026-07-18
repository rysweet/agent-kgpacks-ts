// Top-level runner.
//
// Parses `argv` (user args, without `node`/script) against a freshly built
// program and resolves to the process exit code WITHOUT calling `process.exit`,
// so tests can assert codes directly. The `bin` entry point is the only place
// that actually exits.
//
// Error handling:
//   - `CommanderError` (help/version display, or a usage/parse failure): the text
//     has already been written through the configured output, so we only map the
//     code — `0` for help/version, `2` for any usage error.
//   - any other thrown value: a domain failure. Its message goes to stderr and
//     the exit code is derived from the error taxonomy.

import { CommanderError } from 'commander';

import { PROGRAM_NAME } from './constants.js';
import { EXIT_OK, EXIT_USAGE, exitCodeFor } from './exit-codes.js';
import { processIo } from './io.js';
import { buildProgram, type BuildProgramOptions } from './program.js';

/** Options for {@link run} (same injectable surface as {@link buildProgram}). */
export type RunOptions = BuildProgramOptions;

function normalizeUpdateVersion(argv: string[]): string[] {
  let index = 0;
  const skipGlobalOptions = (): void => {
    while (index < argv.length) {
      if (argv[index] === '--packs-dir') {
        index += 2;
      } else if (argv[index].startsWith('--packs-dir=')) {
        index++;
      } else {
        break;
      }
    }
  };
  skipGlobalOptions();
  let updateIndex = -1;
  if (argv[index] === 'update') {
    updateIndex = index;
  } else if (argv[index] === 'pack') {
    index++;
    skipGlobalOptions();
    if (argv[index] === 'update') updateIndex = index;
  }
  if (updateIndex < 0) return argv;
  return argv.map((arg, index) => {
    if (index <= updateIndex) return arg;
    if (arg === '--version') return '--target-version';
    if (arg.startsWith('--version=')) return `--target-version=${arg.slice('--version='.length)}`;
    return arg;
  });
}

/** Runs the CLI for `argv` and resolves to the process exit code. */
export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const io = options.io ?? processIo;
  const program = buildProgram({ ...options, io });

  if (argv.length === 0) {
    program.outputHelp();
    return EXIT_OK;
  }

  try {
    await program.parseAsync(normalizeUpdateVersion(argv), { from: 'user' });
    return EXIT_OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode === 0 ? EXIT_OK : EXIT_USAGE;
    }

    const message = err instanceof Error ? err.message : String(err);
    io.err(`${PROGRAM_NAME}: ${message}\n`);
    return exitCodeFor(err);
  }
}
