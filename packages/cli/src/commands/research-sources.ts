// `research-sources` — discover candidate source URLs for a domain.
//
// A cheap, fetch-only scout of the source graph: it runs a bounded breadth-first
// crawl from the seeds (no extract / embed / load) via the injectable
// `discoverSources` seam and prints the newly discovered same-domain URLs. The
// seeds are echoed back separately; they never appear in `discovered`. A fetch /
// SSRF failure surfaced by the seam maps to exit 7.

import type { Command } from 'commander';

import { DEFAULT_MAX_ARTICLES, DEFAULT_MAX_DEPTH } from '../constants.js';
import type { CliContext } from '../context.js';
import { printJson } from '../io.js';
import { parsePositiveInt } from '../parse.js';

/** Registers the `research-sources` command on `parent`. */
export function registerResearchSources(parent: Command, ctx: CliContext): Command {
  return parent
    .command('research-sources')
    .description('Discover candidate source URLs reachable from the seeds (fetch-only).')
    .requiredOption('--seeds <url...>', 'seed article URLs to crawl from (HTTPS)')
    .option(
      '--max-depth <n>',
      'maximum link-expansion depth from the seeds',
      parsePositiveInt,
      DEFAULT_MAX_DEPTH,
    )
    .option(
      '--max-articles <n>',
      'hard cap on the number of articles fetched during discovery',
      parsePositiveInt,
      DEFAULT_MAX_ARTICLES,
    )
    .action(async (_opts: unknown, command: Command) => {
      const opts = command.optsWithGlobals();
      const seeds = opts.seeds as string[];
      const discovered = await ctx.discoverSources({
        seeds,
        maxDepth: opts.maxDepth as number,
        maxArticles: opts.maxArticles as number,
      });
      printJson(ctx.io, { seeds, discovered, count: discovered.length });
    });
}
