// test/guard-publish.test.ts
//
// Contract for the publish guard: scripts/guard-publish.mjs.
//
// This repo produces the installable `agent-kgpacks-ts` tarball via `npm pack`,
// but it must NEVER be published from here — the downstream private-feed
// pipeline owns publishing. `prepublishOnly` runs this guard before any
// `npm publish`, so an accidental publish MUST hard-fail (fail closed) unless
// KGPACKS_ALLOW_PUBLISH=1 is explicitly set.
//
// Guard CLI contract (defined by these tests):
//   node scripts/guard-publish.mjs
//     - KGPACKS_ALLOW_PUBLISH === '1'  => exit 0  (deliberate pipeline publish)
//     - anything else                  => exit 1  (fails closed) + explanation
//
// The gate is STRICT string equality on '1' — no coercion of 'true', '0',
// 'yes', whitespace, etc. — so only the exact opt-in unblocks publishing.
//
// TDD: these tests define the contract. They pass once the guard is implemented
// exactly as specified and fail on any regression (e.g. loosened comparison,
// inverted default, missing explanation).

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const guard = join(repoRoot, 'scripts', 'guard-publish.mjs');

// Run the guard with a controlled environment. We deliberately strip any
// ambient KGPACKS_ALLOW_PUBLISH from the parent process so the test is
// deterministic regardless of the shell that launched vitest.
function runGuard(env: Record<string, string | undefined> = {}): {
  status: number;
  output: string;
} {
  const baseEnv = { ...process.env };
  delete baseEnv.KGPACKS_ALLOW_PUBLISH;
  const res = spawnSync('node', [guard], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...baseEnv, ...env },
  });
  return { status: res.status ?? 1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('publish guard — fails closed by default', () => {
  it('exits 1 when KGPACKS_ALLOW_PUBLISH is unset', () => {
    const { status } = runGuard();
    expect(status).toBe(1);
  });

  it('prints an explanation naming the downstream private-feed pipeline', () => {
    const { output } = runGuard();
    expect(output).toMatch(/refus/i);
    expect(output).toMatch(/private-feed pipeline/i);
    // Tells the operator exactly how the intentional pipeline unblocks it.
    expect(output).toMatch(/KGPACKS_ALLOW_PUBLISH=1/);
  });

  it('writes its explanation to stderr (not stdout)', () => {
    const baseEnv = { ...process.env };
    delete baseEnv.KGPACKS_ALLOW_PUBLISH;
    const res = spawnSync('node', [guard], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: baseEnv,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/private-feed pipeline/i);
    expect(res.stdout ?? '').toBe('');
  });
});

describe('publish guard — only the exact opt-in unblocks', () => {
  it('exits 0 when KGPACKS_ALLOW_PUBLISH=1', () => {
    const { status } = runGuard({ KGPACKS_ALLOW_PUBLISH: '1' });
    expect(status).toBe(0);
  });

  it('produces no error output when publishing is allowed', () => {
    const { output } = runGuard({ KGPACKS_ALLOW_PUBLISH: '1' });
    expect(output).toBe('');
  });

  it.each(['0', 'true', 'false', 'yes', 'TRUE', ' 1', '1 ', '01', ''])(
    'stays fail-closed for the non-canonical value %j',
    (value) => {
      const { status } = runGuard({ KGPACKS_ALLOW_PUBLISH: value });
      expect(status).toBe(1);
    },
  );
});
