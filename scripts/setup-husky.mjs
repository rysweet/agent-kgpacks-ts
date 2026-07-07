#!/usr/bin/env node
// scripts/setup-husky.mjs
//
// Installs the local Husky git hooks, but ONLY in a developer checkout. This is
// invoked from the package `prepare` script *after* the esbuild bundle step, so
// it must never mask a real bundle build failure and must never fail the install
// in an environment where Husky is neither wanted nor possible:
//
//   - Consumers installing the packed tarball (or a git dependency) have no dev
//     tooling and often no writable .git — Husky must no-op there.
//   - CI runs with CI=1 and does not need local commit hooks.
//   - `HUSKY=0` (or `HUSKY=false`) is the documented opt-out.
//   - Outside a git work tree there is nothing to hook into.
//
// In every one of those cases we exit 0 so `prepare` succeeds. Only in a real
// developer checkout do we run `husky`, and a genuine Husky failure there is
// surfaced (non-zero exit) so it is not silently swallowed.
import { spawnSync } from 'node:child_process';

function skip(reason) {
  console.error(`husky: skipped (${reason})`);
  process.exit(0);
}

const huskyFlag = (process.env.HUSKY ?? '').toLowerCase();
if (huskyFlag === '0' || huskyFlag === 'false') skip('HUSKY disabled via env');
if (process.env.CI) skip('CI environment');

// Not inside a git work tree (e.g. a consumer install from a tarball) -> no-op.
const inWorkTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
  stdio: ['ignore', 'pipe', 'ignore'],
  encoding: 'utf8',
});
if (inWorkTree.status !== 0 || inWorkTree.stdout.trim() !== 'true') {
  skip('not a git work tree');
}

// Real developer checkout: install the hooks and surface any genuine failure.
const result = spawnSync('husky', [], { stdio: 'inherit', shell: false });
if (result.error && result.error.code === 'ENOENT') {
  // The husky binary is a devDependency; a consumer/CI path without it should
  // already have been skipped above. If we still get here, do not fail install.
  skip('husky binary not installed');
}
process.exit(result.status ?? 0);
