// `pack eval` — evaluate a pack with @kgpacks/eval.
//
// Scores the WITH-PACK arm (full retrieve + synthesize over the pack) against the
// TRAINING-ONLY arm (no pack context) with a single LLM judge pinned to one model
// and held constant across both arms. The pack must exist (else exit 3); the heavy
// eval/retrieval/agent stack is loaded lazily by the injected `evalPack` seam. On
// success the full `EvalReport` is printed as JSON; an `EvalError` maps to exit 8.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Command, Option } from 'commander';

import {
  DB_FILENAME,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_PER_PACK,
  DEFAULT_SAMPLE,
  SAMPLE_MODES,
} from '../constants.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { EXIT_PACK_NOT_FOUND } from '../exit-codes.js';
import { printJson } from '../io.js';
import { resolveExistingPackDir } from '../pack-dir.js';
import { parsePositiveInt } from '../parse.js';

/** Registers the `eval` command on `parent` (the `pack` group). */
export function registerEval(parent: Command, ctx: CliContext): Command {
  return parent
    .command('eval')
    .description('Evaluate a pack: with-pack vs training-only, scored by a pinned judge.')
    .requiredOption('--pack <name>', 'pack directory name to evaluate')
    .option(
      '--questions <dir>',
      'base directory for per-pack eval_questions.json (default: the packs dir)',
    )
    .addOption(
      new Option('--sample <mode>', 'sampling mode')
        .choices([...SAMPLE_MODES])
        .default(DEFAULT_SAMPLE),
    )
    .option(
      '--per-pack <n>',
      'questions per pack in stratified mode',
      parsePositiveInt,
      DEFAULT_PER_PACK,
    )
    .option(
      '--judge-model <id>',
      'judge model id, held constant across both arms',
      DEFAULT_JUDGE_MODEL,
    )
    .action(async (_opts: unknown, command: Command) => {
      const opts = command.optsWithGlobals();
      const packsDir = ctx.packsDirFor(opts.packsDir as string | undefined);
      const pack = opts.pack as string;
      const packDir = resolveExistingPackDir(packsDir, pack);
      // Confirm the pack database exists BEFORE invoking the seam: the Database
      // constructor opens-or-creates, so without this guard eval would silently
      // write an empty pack.db and spin up the agent before failing. Mirrors the
      // `query` command's guard.
      const dbPath = join(packDir, DB_FILENAME);
      if (!existsSync(dbPath)) {
        throw new CliError(`Database not found at ${dbPath}`, EXIT_PACK_NOT_FOUND);
      }

      const report = await ctx.evalPack({
        packDir,
        packId: pack,
        questionsDir: (opts.questions as string | undefined) ?? packsDir,
        sample: opts.sample as 'full' | 'stratified',
        perPack: opts.perPack as number,
        judgeModel: opts.judgeModel as string,
      });
      printJson(ctx.io, report);
    });
}
