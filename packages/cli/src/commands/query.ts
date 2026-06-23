// `query <pack> <question>` — ranked retrieval over a pack's graph.
//
// Resolves and path-safety-checks the pack, confirms its database exists, then
// delegates to the injectable query runner and prints the result as pretty JSON.
// The retrieval stack itself is loaded lazily by the default runner, so this
// module stays cheap to import.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { RetrieveMode } from '@kgpacks/query';
import { Command, Option } from 'commander';

import { DB_FILENAME, DEFAULT_K, DEFAULT_MODE, RETRIEVE_MODES } from '../constants.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { EXIT_QUERY } from '../exit-codes.js';
import { printJson } from '../io.js';
import { resolveExistingPackDir } from '../pack-dir.js';
import { parsePositiveInt } from '../parse.js';

/** Registers the `query` command on `parent`. */
export function registerQuery(parent: Command, ctx: CliContext): void {
  parent
    .command('query')
    .description('Query a knowledge pack and print ranked retrieval results as JSON.')
    .argument('<pack>', 'pack directory name')
    .argument('<question>', 'natural-language question')
    .option('-k, --k <n>', 'number of results to retrieve', parsePositiveInt, DEFAULT_K)
    .addOption(
      new Option('--mode <mode>', 'retrieval strategy')
        .choices(RETRIEVE_MODES)
        .default(DEFAULT_MODE),
    )
    .action(async (pack: string, question: string, _opts: unknown, command: Command) => {
      const opts = command.optsWithGlobals();
      const packsDir = ctx.packsDirFor(opts.packsDir as string | undefined);
      const packDir = resolveExistingPackDir(packsDir, pack);
      const dbPath = join(packDir, DB_FILENAME);
      if (!existsSync(dbPath)) {
        throw new CliError(`Database not found at ${dbPath}`, EXIT_QUERY);
      }
      const result = await ctx.runQuery({
        packName: pack,
        dbPath,
        question,
        k: opts.k as number,
        mode: opts.mode as RetrieveMode,
      });
      printJson(ctx.io, result);
    });
}
