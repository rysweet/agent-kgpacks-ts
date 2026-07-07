// test/setup-husky.test.ts
//
// Contract for the husky git-hooks guard: scripts/setup-husky.mjs.
//
// `prepare` runs on dev checkouts AND on consumer/CI installs. The esbuild
// bundle step runs FIRST in `prepare` and must fail loudly; this husky guard is
// deliberately decoupled from it and must NEVER fail the install just because
// git hooks can't (or shouldn't) be set up. So the guard is FAIL OPEN: it always
// exits 0, only actually installing hooks inside a real dev git work tree.
//
// Guard CLI contract (defined by these tests):
//   node scripts/setup-husky.mjs
//     - HUSKY=0 / HUSKY=false        => skip, exit 0
//     - CI set (any truthy)          => skip, exit 0
//     - not inside a git work tree   => skip, exit 0
//     - husky absent                 => skip, exit 0
//     - dev git work tree + husky     => install hooks, exit 0 (no "skipping")
//
// Every skip path logs a human-readable reason to stderr so a confused operator
// can see WHY hooks weren't installed.
//
// TDD: these tests define the contract. They pass once the guard is implemented
// exactly as specified and fail on any regression (e.g. a skip path that exits
// non-zero, or the install path silently no-opping in a dev tree).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const guard = join(repoRoot, 'scripts', 'setup-husky.mjs');

// Run the guard from a chosen cwd with a controlled environment. The guard
// resolves `husky` relative to its own file location (import.meta.url), so it
// always finds the repo's husky regardless of cwd — meaning we can point cwd at
// an isolated temp git repo and install hooks THERE, never mutating the real
// repository under test.
function runGuard(opts: { cwd?: string; env?: Record<string, string | undefined> }): {
  status: number;
  output: string;
} {
  // Start from a clean env so an ambient CI=... from the test runner doesn't
  // leak into cases that must exercise the git-work-tree branch.
  const baseEnv = { ...process.env };
  delete baseEnv.CI;
  delete baseEnv.HUSKY;
  const res = spawnSync('node', [guard], {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf8',
    env: { ...baseEnv, ...(opts.env ?? {}) },
  });
  return { status: res.status ?? 1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'husky-git-'));
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  expect(init.status).toBe(0);
  spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
  return dir;
}

describe('husky guard — fails open on every skip path', () => {
  it('exits 0 and explains when HUSKY=0', () => {
    const { status, output } = runGuard({ env: { HUSKY: '0' } });
    expect(status).toBe(0);
    expect(output).toMatch(/skip/i);
    expect(output).toMatch(/HUSKY/);
  });

  it('exits 0 when HUSKY=false', () => {
    const { status, output } = runGuard({ env: { HUSKY: 'false' } });
    expect(status).toBe(0);
    expect(output).toMatch(/skip/i);
  });

  it('exits 0 and explains when running under CI', () => {
    const { status, output } = runGuard({ env: { CI: '1' } });
    expect(status).toBe(0);
    expect(output).toMatch(/skip/i);
    expect(output).toMatch(/CI/i);
  });

  it('exits 0 and explains when not inside a git work tree', () => {
    // A bare temp dir that is deliberately NOT a git repo.
    const dir = mkdtempSync(join(tmpdir(), 'husky-nogit-'));
    try {
      const { status, output } = runGuard({ cwd: dir });
      expect(status).toBe(0);
      expect(output).toMatch(/skip/i);
      expect(output).toMatch(/git work tree/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('husky guard — installs hooks in a dev git work tree', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeGitRepo();
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0, does NOT skip, and installs husky hooks', () => {
    const { status, output } = runGuard({ cwd: dir });
    expect(status).toBe(0);
    // The whole point: in a real dev tree it must take the install path.
    expect(output).not.toMatch(/skipping/i);
    // husky 9 installs its hook runner under .husky/_ and points git at it.
    expect(existsSync(join(dir, '.husky', '_'))).toBe(true);
    const hooksPath = spawnSync('git', ['config', 'core.hooksPath'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect((hooksPath.stdout ?? '').trim()).toBe('.husky/_');
  });

  it('does not mutate the repository running the tests', () => {
    // Guard against a regression where cwd is ignored and hooks are (re)written
    // into the real repo. Running against the temp repo must leave the real
    // repo's git config untouched by this invocation.
    const before = spawnSync('git', ['config', 'core.hooksPath'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    runGuard({ cwd: dir });
    const after = spawnSync('git', ['config', 'core.hooksPath'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect((after.stdout ?? '').trim()).toBe((before.stdout ?? '').trim());
  });
});
