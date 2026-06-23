// @kgpacks/cli — public entry point.
//
// The `wikigr` command-line interface (Phase 1, RUNTIME commands): `query`,
// `status`, and `pack { install, list, info, validate, remove }`. Ingestion
// commands land in Phase 2. The executable lives in `bin.ts`; everything here is
// the importable surface (program factory, runner, exit-code contract, and the
// injectable query/output seams) used by the executable and by tests.

export { buildProgram } from './program.js';
export type { BuildProgramOptions } from './program.js';

export { run } from './run.js';
export type { RunOptions } from './run.js';

export { resolvePacksDir } from './config.js';
export type { ResolvePacksDirOptions } from './config.js';

export { CliError } from './errors.js';

export {
  EXIT_OK,
  EXIT_GENERIC,
  EXIT_USAGE,
  EXIT_PACK_NOT_FOUND,
  EXIT_VALIDATION,
  EXIT_INSTALL,
  EXIT_QUERY,
  exitCodeFor,
} from './exit-codes.js';

export { defaultQueryRunner } from './query-runner.js';
export type { QueryRunner, QueryRunnerInput, DefaultQueryResult } from './query-runner.js';

export { processIo, createBufferedIo, printJson } from './io.js';
export type { Io, BufferedIo } from './io.js';

export {
  PROGRAM_NAME,
  CLI_VERSION,
  DEFAULT_K,
  DEFAULT_MODE,
  PACKS_DIR_ENV,
  DB_FILENAME,
  RETRIEVE_MODES,
} from './constants.js';
