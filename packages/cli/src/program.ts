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

import { registerCreate } from './commands/build.js';
import { registerPack } from './commands/pack.js';
import { registerQuery } from './commands/query.js';
import { registerResearchSources } from './commands/research-sources.js';
import { registerStatus } from './commands/status.js';
import { registerUpdate } from './commands/update.js';
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
import { defaultUpdateKnowledgePack, type UpdateKnowledgePackSeam } from './update-runner.js';

/** Construction options for {@link buildProgram}. */
export interface BuildProgramOptions {
  /** Output sink. Defaults to the process streams. */
  io?: Io;
  /** `query` execution seam. Defaults to the lazy production runner. */
  runQuery?: QueryRunner;
  /** `create` / `update` build seam. Defaults to the lazy `@kgpacks/ingestion` `buildPack`. */
  buildPack?: BuildPackSeam;
  /** Immutable incremental update seam. */
  updateKnowledgePack?: UpdateKnowledgePackSeam;
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

function normalizeUpdateVersion(argv: readonly string[], commandOffset: number): string[] {
  let index = commandOffset;
  const skipGlobalOptions = (): void => {
    while (index < argv.length) {
      if (argv[index] === '--packs-dir') index += 2;
      else if (argv[index].startsWith('--packs-dir=')) index++;
      else break;
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
  if (updateIndex < 0) return [...argv];
  return argv.map((arg, position) => {
    if (position <= updateIndex) return arg;
    if (arg === '--version') return '--target-version';
    if (arg.startsWith('--version=')) return `--target-version=${arg.slice('--version='.length)}`;
    return arg;
  });
}

function commandOffset(from: 'user' | 'node' | 'electron' | undefined): number {
  if (from === 'user') return 0;
  if (from === 'electron') {
    return (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true ? 2 : 1;
  }
  return 2;
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
    updateKnowledgePack: options.updateKnowledgePack ?? defaultUpdateKnowledgePack(),
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
  const parseAsync = program.parseAsync.bind(program);
  program.parseAsync = (argv, parseOptions) => {
    if (argv === undefined) {
      return parseAsync(normalizeUpdateVersion(process.argv, 2), {
        ...parseOptions,
        from: 'node',
      });
    }
    return parseAsync(
      normalizeUpdateVersion(argv, commandOffset(parseOptions?.from)),
      parseOptions,
    );
  };
  return program;
}
