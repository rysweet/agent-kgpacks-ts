// `pack { install, list, info, validate, remove }` — registry management.
//
// Thin command bindings over `@kgpacks/packs`: each subcommand resolves the
// packs directory, calls the corresponding package API, and prints pretty JSON.
// The underlying APIs own path safety and the typed error taxonomy the CLI maps
// to exit codes. Invoking `pack` with no subcommand is a usage error (exit 2).

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  MANIFEST_FILENAME,
  installPack,
  listPacks,
  loadManifestFromDir,
  packInfo,
  removePack,
} from '@kgpacks/packs';
import { Command } from 'commander';

import { DEFAULT_PACK_REPO, DEFAULT_PACK_TAG } from '../constants.js';
import type { CliContext } from '../context.js';
import { CliError } from '../errors.js';
import { EXIT_PACK_NOT_FOUND } from '../exit-codes.js';
import { printJson } from '../io.js';
import { pullPack } from '../pack-pull.js';
import { resolveExistingPackDir } from '../pack-dir.js';
import { registerCreate, registerUpdate } from './build.js';
import { registerEval } from './eval.js';

/** Registers the `pack` command group on `parent`. */
export function registerPack(parent: Command, ctx: CliContext): void {
  const pack = parent.command('pack').description('Manage installed knowledge packs.');

  const packsDirOf = (command: Command): string =>
    ctx.packsDirFor(command.optsWithGlobals().packsDir as string | undefined);

  pack
    .command('install')
    .description('Install a pack from a local .tar.gz archive.')
    .argument('<archive>', 'path to a pack .tar.gz archive')
    .action((archive: string, _opts: unknown, command: Command) => {
      const installed = installPack(archive, packsDirOf(command));
      printJson(ctx.io, {
        name: installed.name,
        version: installed.version,
        path: installed.path,
      });
    });

  pack
    .command('pull')
    .description(
      'Download and install a pack from a GitHub release (multi-part, integrity-checked).',
    )
    .argument('<name>', 'pack name (matches <name>.pack-release.json in the release)')
    .option('--repo <owner/repo>', 'source repository', DEFAULT_PACK_REPO)
    .option('--tag <tag>', 'release tag hosting the pack assets', DEFAULT_PACK_TAG)
    .option('--base-url <url>', 'base URL of the index + parts (overrides --repo/--tag)')
    .action(async (name: string, _opts: unknown, command: Command) => {
      const opts = command.optsWithGlobals();
      const installed = await pullPack({
        name,
        packsDir: packsDirOf(command),
        repo: opts.repo as string | undefined,
        tag: opts.tag as string | undefined,
        baseUrl: opts.baseUrl as string | undefined,
      });
      printJson(ctx.io, installed);
    });

  pack
    .command('list')
    .description('List installed packs.')
    .action((_opts: unknown, command: Command) => {
      const packs = listPacks(packsDirOf(command))
        .map((p) => ({
          name: p.name,
          version: p.version,
          description: typeof p.manifest.description === 'string' ? p.manifest.description : '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      printJson(ctx.io, packs);
    });

  pack
    .command('info')
    .description("Print a pack's full manifest.")
    .argument('<pack>', 'pack directory name')
    .action((name: string, _opts: unknown, command: Command) => {
      const info = packInfo(packsDirOf(command), name);
      printJson(ctx.io, info.manifest);
    });

  pack
    .command('validate')
    .description("Validate a pack's manifest.")
    .argument('<pack>', 'pack directory name')
    .action((name: string, _opts: unknown, command: Command) => {
      const dir = resolveExistingPackDir(packsDirOf(command), name);
      if (!existsSync(join(dir, MANIFEST_FILENAME))) {
        throw new CliError(`pack not found: ${name}`, EXIT_PACK_NOT_FOUND);
      }
      const manifest = loadManifestFromDir(dir);
      printJson(ctx.io, { valid: true, name: manifest.name, version: manifest.version });
    });

  pack
    .command('remove')
    .description('Remove an installed pack.')
    .argument('<pack>', 'pack directory name')
    .action((name: string, _opts: unknown, command: Command) => {
      removePack(packsDirOf(command), name);
      printJson(ctx.io, { removed: name });
    });

  // INGESTION verbs, mounted under the `pack` group as well as top-level. The
  // shared factories give `pack create` / `pack update` identical behaviour to
  // `create` / `update`; `eval` lives only under the group.
  registerCreate(pack, ctx);
  registerEval(pack, ctx);
  registerUpdate(pack, ctx);

  // `pack` with no subcommand → print usage to stderr and exit 2.
  pack.action((_opts: unknown, command: Command) => {
    command.help({ error: true });
  });
}
