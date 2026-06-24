#!/usr/bin/env node
// Bundles the `wikigr` CLI into a single self-contained ESM file so the package
// can be installed straight from this git repo (or an `npm pack` tarball) WITHOUT
// the consumer ever resolving the internal `@kgpacks/* workspace:*` dependencies.
//
// esbuild inlines every `@kgpacks/*` workspace package (by aliasing each to its
// TypeScript source entry) and leaves the real npm dependencies external — they
// are declared in this package's `dependencies`, so the consumer's package manager
// installs them normally. Runs from `prepare`, so a git/tarball install builds it.
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Alias every workspace package (@kgpacks/<dir>) to its source entry so esbuild
// bundles it inline rather than treating it as an unresolved bare import.
const alias = {};
for (const dir of readdirSync(join(root, 'packages'))) {
  alias[`@kgpacks/${dir}`] = join(root, 'packages', dir, 'src', 'index.ts');
}

// Keep every non-workspace bare import (real npm deps + node builtins) external.
const externalizeRealDeps = {
  name: 'externalize-real-deps',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      if (args.path.startsWith('.') || args.path.startsWith('/')) return null;
      if (args.path.startsWith('@kgpacks/')) return null; // bundled via alias
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: [join(root, 'packages', 'cli', 'src', 'bin.ts')],
  outfile: join(root, 'dist', 'wikigr.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias,
  plugins: [externalizeRealDeps],
  legalComments: 'none',
  logLevel: 'info',
});

console.error('bundled dist/wikigr.mjs');
