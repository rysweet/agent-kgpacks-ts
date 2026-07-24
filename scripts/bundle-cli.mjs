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
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

mkdirSync(dist, { recursive: true });
rmSync(join(dist, 'rename-noreplace'), { force: true });
for (const architecture of ['x64', 'arm64']) {
  const helperName = `rename-noreplace-linux-${architecture}`;
  const helper = join(dist, helperName);
  copyFileSync(join(root, 'native', 'prebuilds', helperName), helper);
  chmodSync(helper, 0o755);
}

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
  outfile: join(dist, 'wikigr.mjs'),
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
