// test/check-no-python.test.ts
//
// Contract for the python-free security gate: scripts/check-no-python.mjs.
//
// Enforces docs/PLAN.md's hard constraint — no RUNTIME package may declare or
// invoke a Python dependency (Python is allowed only as a dev-time parity oracle
// outside the packages/ graph).
//
// Guard CLI contract (defined by these tests):
//   node scripts/check-no-python.mjs [scanDir]
//     - scanDir defaults to "packages"
//     - scans <scanDir>/<pkg>/package.json deps AND <scanDir>/<pkg>/src/**
//     - exit 0  => clean (no Python references)
//     - exit 1  => at least one violation (fails closed)
//
// TDD: FAILS today (scripts/check-no-python.mjs does not exist) and PASSES once
// the guard is implemented and the real packages tree is clean.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const guard = join(repoRoot, 'scripts', 'check-no-python.mjs');

function runGuard(scanDir?: string): { status: number; output: string } {
  const args = scanDir ? [guard, scanDir] : [guard];
  const res = spawnSync('node', args, { cwd: repoRoot, encoding: 'utf8' });
  return { status: res.status ?? 1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

// Build a packages/-shaped fixture: <root>/<pkg>/{package.json,src/index.ts}
function makePackage(
  root: string,
  name: string,
  pkgJson: Record<string, unknown>,
  src = 'export const placeholder = true;\n',
): void {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2));
  writeFileSync(join(dir, 'src', 'index.ts'), src);
}

describe('python-free guard — happy path', () => {
  it('exits 0 on the real, clean packages/ tree (default scan dir)', () => {
    const { status } = runGuard();
    expect(status).toBe(0);
  });

  it('exits 0 on a clean fixture passed as an explicit scan dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-clean-'));
    try {
      makePackage(root, 'db', {
        name: '@kgpacks/db',
        type: 'module',
        dependencies: { '@ladybugdb/core': '0.17.1' },
      });
      makePackage(root, 'cli', {
        name: '@kgpacks/cli',
        type: 'module',
        dependencies: { '@kgpacks/db': 'workspace:*' },
      });
      const { status } = runGuard(root);
      expect(status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('python-free guard — fails closed on violations', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'guard-bad-'));
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('rejects a Python-flavored runtime dependency in a package.json', () => {
    const sub = mkdtempSync(join(tmpdir(), 'guard-dep-'));
    try {
      makePackage(sub, 'agent', {
        name: '@kgpacks/agent',
        type: 'module',
        dependencies: { 'python-shell': '^5.0.0' },
      });
      const { status, output } = runGuard(sub);
      expect(status).toBe(1);
      expect(output).toMatch(/python/i);
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });

  it('rejects source that spawns python / invokes a .py script', () => {
    const sub = mkdtempSync(join(tmpdir(), 'guard-src-'));
    try {
      makePackage(
        sub,
        'backend',
        { name: '@kgpacks/backend', type: 'module' },
        [
          "import { spawn } from 'node:child_process';",
          "export const run = () => spawn('python3', ['scripts/extract.py']);",
          '',
        ].join('\n'),
      );
      const { status } = runGuard(sub);
      expect(status).toBe(1);
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });
});
