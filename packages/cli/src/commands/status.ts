// `status` — resolved packs directory plus a per-pack summary.
//
// Lists the installed packs (a missing directory yields an empty list, never an
// error) and reports, for each, whether its database file is present. Output is
// pretty JSON: `{ packsDir, count, packs: [{ name, version, dbPresent }] }`.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listPacks } from '@kgpacks/packs';
import type { Command } from 'commander';

import { DB_FILENAME } from '../constants.js';
import type { CliContext } from '../context.js';
import { printJson } from '../io.js';

/** Registers the `status` command on `parent`. */
export function registerStatus(parent: Command, ctx: CliContext): void {
  parent
    .command('status')
    .description('Report the resolved packs directory and the installed packs.')
    .action((_opts: unknown, command: Command) => {
      const packsDir = ctx.packsDirFor(command.optsWithGlobals().packsDir as string | undefined);
      const packs = listPacks(packsDir)
        .map((p) => ({
          name: p.name,
          version: p.version,
          dbPresent: existsSync(join(p.path, DB_FILENAME)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      printJson(ctx.io, { packsDir, count: packs.length, packs });
    });
}
