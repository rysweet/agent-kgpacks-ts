import { Option, type Command } from 'commander';

import type { CliContext } from '../context.js';
import { printJson } from '../io.js';

/** Registers immutable incremental update and explicit resume modes. */
export function registerUpdate(parent: Command, ctx: CliContext): Command {
  return parent
    .command('update')
    .description('Build a new immutable pack version from a completed base and CVE delta.')
    .option('--base <pack-dir>', 'completed provenance-capable base pack')
    .option('--delta <file>', 'CVE NDJSON upsert delta')
    .option('--output <pack-dir>', 'new immutable pack directory')
    .option('--version <version>', 'target pack version')
    .addOption(new Option('--target-version <version>').hideHelp())
    .option('--work-dir <dir>', 'durable update work directory (default: <output>.work)')
    .option('--resume <work-dir>', 'resume an interrupted incremental update')
    .action(async (_opts: unknown, command: Command) => {
      const opts = command.optsWithGlobals();
      const targetVersion = (opts.targetVersion ?? opts.version) as string | undefined;
      const freshNames = ['base', 'delta', 'output', 'version', 'workDir'] as const;
      const suppliedFresh = freshNames.filter((name) =>
        name === 'version' ? targetVersion !== undefined : opts[name] !== undefined,
      );
      if (opts.resume !== undefined) {
        if (suppliedFresh.length > 0) {
          command.error('--resume and fresh update options are mutually exclusive.');
        }
        printJson(ctx.io, await ctx.updateKnowledgePack({ resume: opts.resume as string }));
        return;
      }
      const required = ['base', 'delta', 'output', 'version'] as const;
      const missing = required.filter((name) =>
        name === 'version' ? targetVersion === undefined : opts[name] === undefined,
      );
      if (missing.length > 0) {
        command.error(`fresh update requires ${required.map((name) => `--${name}`).join(', ')}.`);
      }
      printJson(
        ctx.io,
        await ctx.updateKnowledgePack({
          base: opts.base as string,
          delta: opts.delta as string,
          output: opts.output as string,
          version: targetVersion as string,
          workDir: opts.workDir as string | undefined,
        }),
      );
    });
}
