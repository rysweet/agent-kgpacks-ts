// Program factory.
//
// Assembles the `wikigr` commander program with the global `--packs-dir` option
// and every command: the Phase-1 RUNTIME commands (`query`, `status`, and the
// `pack` group) and the Phase-2 INGESTION commands (`create`, `update`,
// `research-sources`, plus `pack create` / `pack eval` / `pack update`). Each
// command's execution seam (query, build, discovery, eval) is injectable; unset,
// they fall back to the production defaults, which load their heavy stacks lazily.
// `exitOverride` + an injected output sink are applied to every command so failures
// surface as thrown `CommanderError`s and all output is capturable — making the
// program fully testable in-process.

import { Command } from 'commander';

import { registerCreate, registerUpdate } from './commands/build.js';
import { registerPack } from './commands/pack.js';
import { registerQuery } from './commands/query.js';
import { registerResearchSources } from './commands/research-sources.js';
import { registerStatus } from './commands/status.js';
import { resolvePacksDir } from './config.js';
import { CLI_VERSION, PROGRAM_NAME } from './constants.js';
import type { CliContext } from './context.js';
import { defaultEvalPack, type EvalSeam } from './eval-runner.js';
import {
  defaultBuildPack,
  defaultDiscoverSources,
  type BuildPackSeam,
  type DiscoverSourcesSeam,
} from './ingestion-runner.js';
import { processIo, type Io } from './io.js';
import { defaultQueryRunner, type QueryRunner } from './query-runner.js';

/** Construction options for {@link buildProgram}. */
export interface BuildProgramOptions {
  /** Output sink. Defaults to the process streams. */
  io?: Io;
  /** `query` execution seam. Defaults to the lazy production runner. */
  runQuery?: QueryRunner;
  /** `create` / `update` build seam. Defaults to the lazy `@kgpacks/ingestion` `buildPack`. */
  buildPack?: BuildPackSeam;
  /** `research-sources` discovery seam. Defaults to the lazy fetch-only crawler. */
  discoverSources?: DiscoverSourcesSeam;
  /** `pack eval` execution seam. Defaults to the lazy `@kgpacks/eval` `runEval`. */
  evalPack?: EvalSeam;
  /** Programmatic packs-directory override (below `--packs-dir`, above env). */
  packsDir?: string;
  /** Environment read for `KGPACKS_PACKS_DIR`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the default packs layout. Defaults to `process.cwd()`. */
  cwd?: string;
}

function applyExitAndOutput(command: Command, io: Io): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => io.out(str),
    writeErr: (str) => io.err(str),
  });
  for (const sub of command.commands) {
    applyExitAndOutput(sub, io);
  }
}

/** Builds the configured `wikigr` program. */
export function buildProgram(options: BuildProgramOptions = {}): Command {
  const io = options.io ?? processIo;
  const ctx: CliContext = {
    io,
    runQuery: options.runQuery ?? defaultQueryRunner(),
    buildPack: options.buildPack ?? defaultBuildPack(),
    discoverSources: options.discoverSources ?? defaultDiscoverSources(),
    evalPack: options.evalPack ?? defaultEvalPack(),
    packsDirFor: (flag) =>
      resolvePacksDir({
        flag,
        injected: options.packsDir,
        env: options.env,
        cwd: options.cwd,
      }),
  };

  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description('Knowledge-pack command-line interface (query, ingestion, and pack management).')
    .version(CLI_VERSION)
    .option('--packs-dir <dir>', 'directory containing installed packs');

  registerQuery(program, ctx);
  registerStatus(program, ctx);
  registerCreate(program, ctx);
  registerUpdate(program, ctx);
  registerResearchSources(program, ctx);
  registerPack(program, ctx);

  applyExitAndOutput(program, io);
  return program;
}
