#!/usr/bin/env node
// Sets up husky git hooks for local development, but NEVER fails outside a dev
// checkout. `prepare` also runs on consumer/CI installs where husky is absent,
// where there is no git work tree, or where hooks are unwanted (CI / HUSKY=0).
// In those cases this script no-ops and exits 0. It is intentionally decoupled
// from the esbuild bundle step (which runs first in `prepare` and MUST fail
// loudly) so bundle failures are never masked by this guard.
import { spawnSync } from 'node:child_process';

function skip(reason) {
  console.error(`setup-husky: skipping git hooks (${reason})`);
  process.exit(0);
}

if (process.env.HUSKY === '0' || process.env.HUSKY === 'false') skip('HUSKY disabled');
if (process.env.CI) skip('CI environment');

// Only install hooks inside a real git work tree.
const inGitTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
  stdio: ['ignore', 'pipe', 'ignore'],
});
if (inGitTree.status !== 0 || String(inGitTree.stdout).trim() !== 'true') {
  skip('not a git work tree');
}

// husky is a devDependency and may be absent in consumer installs. Resolve it
// dynamically so its absence is a no-op rather than a hard failure. husky 9
// only exports `./index.js`, so locate its `bin.js` as a sibling of the package
// entry rather than via a subpath resolve (which its `exports` map forbids).
const { createRequire } = await import('node:module');
const { dirname, join } = await import('node:path');
const { existsSync } = await import('node:fs');
const require = createRequire(import.meta.url);

let huskyBin;
try {
  huskyBin = join(dirname(require.resolve('husky')), 'bin.js');
} catch {
  skip('husky not installed');
}
if (!existsSync(huskyBin)) skip('husky bin not found');

const res = spawnSync(process.execPath, [huskyBin], { stdio: 'inherit' });
process.exit(res.status ?? 0);
