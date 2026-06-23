// test/docker-deployment.test.ts
//
// Structural / contract suite for the Phase 3 production Docker + deployment
// setup (issue #29).
//
// Encodes the deliverables from docs/deployment.md and the design spec as
// executable assertions over the *infrastructure* artifacts only:
//   - Dockerfile            (multi-stage GLIBC build of @kgpacks/backend)
//   - .dockerignore         (minimal, secret-free build context)
//   - docker-compose.yml    (one-command run, persistent volume, hardening)
//   - docs/deployment.md    (operator guide: glibc rationale, env, pinning)
//   - .github/workflows/ci.yml  (docker-image build + no-Python assertion)
//
// TDD: these FAIL today (Dockerfile / .dockerignore / docker-compose.yml do not
// exist and ci.yml has no docker-image job) and PASS once the infrastructure is
// in place. Pure filesystem / text checks — no source imports, no new deps, and
// (per the task constraint) no changes to package source or package tests.
//
// Run by the ROOT vitest config (include test/**).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const exists = (rel: string): boolean => existsSync(join(repoRoot, rel));

// Safe read: returns '' for a missing file so each assertion fails with a clear
// "expected to match" message instead of the whole describe block erroring out.
const read = (rel: string): string => {
  try {
    return readFileSync(join(repoRoot, rel), 'utf8');
  } catch {
    return '';
  }
};

describe('docker deployment — artifacts exist', () => {
  it.each(['Dockerfile', '.dockerignore', 'docker-compose.yml', 'docs/deployment.md'])(
    'provides %s',
    (rel) => {
      expect(exists(rel)).toBe(true);
    },
  );
});

describe('Dockerfile — GLIBC base, never Alpine/musl, never Python', () => {
  const df = (): string => read('Dockerfile');

  it('builds on the GLIBC node:22-bookworm-slim base image', () => {
    expect(df()).toMatch(/FROM\s+node:22-bookworm-slim/);
  });

  it('never uses an Alpine/musl base (no musl prebuilt for @ladybugdb/core)', () => {
    expect(df()).not.toMatch(/alpine/i);
    expect(df()).not.toMatch(/\bmusl\b/i);
  });

  it('introduces no Python (no source-compile toolchain, no python install)', () => {
    const text = df();
    expect(text).not.toMatch(/python/i);
    expect(text).not.toMatch(/apt-get\s+install[^\n]*\b(build-essential|g\+\+|cmake)\b/i);
  });

  it('is multi-stage with named build and runtime stages', () => {
    const text = df();
    const fromCount = (text.match(/^FROM\s+/gm) ?? []).length;
    expect(fromCount).toBeGreaterThanOrEqual(2);
    expect(text).toMatch(/^FROM\s+\S+\s+AS\s+build/im);
    expect(text).toMatch(/^FROM\s+\S+\s+AS\s+runtime/im);
  });
});

describe('Dockerfile — corepack/pnpm, install, build, prune', () => {
  const df = (): string => read('Dockerfile');

  it('enables corepack and pins pnpm@9.15.0 (matches packageManager)', () => {
    const text = df();
    expect(text).toMatch(/corepack\s+enable/);
    expect(text).toMatch(/corepack\s+prepare\s+pnpm@9\.15\.0/);
  });

  it('installs workspace deps with a frozen lockfile', () => {
    expect(df()).toMatch(/pnpm\s+install\s+--frozen-lockfile/);
  });

  it('builds the whole workspace recursively', () => {
    expect(df()).toMatch(/pnpm\s+-r\s+build/);
  });

  it('prunes to the @kgpacks/backend production runtime closure via pnpm deploy', () => {
    const text = df();
    expect(text).toMatch(/pnpm\s+deploy/);
    expect(text).toMatch(/@kgpacks\/backend/);
    expect(text).toMatch(/--prod\b/);
  });

  it('smoke-checks that the @ladybugdb/core native binding loads in the build stage', () => {
    expect(df()).toMatch(/require\((['"])@ladybugdb\/core\1\)/);
  });
});

describe('Dockerfile — hardened runtime stage', () => {
  const df = (): string => read('Dockerfile');

  it('runs as the non-root node user', () => {
    expect(df()).toMatch(/^\s*USER\s+node\s*$/m);
  });

  it('sets NODE_ENV=production', () => {
    expect(df()).toMatch(/NODE_ENV[ =]production/);
  });

  it('defaults the in-container bind to 0.0.0.0:8000 and EXPOSEs 8000', () => {
    const text = df();
    expect(text).toMatch(/WIKIGR_HOST[ =]0\.0\.0\.0/);
    expect(text).toMatch(/WIKIGR_PORT[ =]8000/);
    expect(text).toMatch(/^\s*EXPOSE\s+8000\s*$/m);
  });

  it('declares a WORKDIR and runs the backend via node dist/index.js', () => {
    const text = df();
    expect(text).toMatch(/^\s*WORKDIR\s+\S+/m);
    expect(text).toMatch(/CMD\s+\[[^\]]*"node"[^\]]*"dist\/index\.js"[^\]]*\]/);
  });
});

describe('.dockerignore — minimal, secret-free build context', () => {
  const di = (): string => read('.dockerignore');

  it('excludes build/install noise: node_modules, dist, .git', () => {
    const text = di();
    expect(text).toMatch(/(^|\/)node_modules/m);
    expect(text).toMatch(/(^|\/)dist/m);
    expect(text).toMatch(/(^|\n)[^\n]*\.git\b/);
  });

  it('excludes tests from the image', () => {
    expect(di()).toMatch(/test/i);
  });

  it('excludes secrets and local agent state (.env*, *.key, *.pem, .claude)', () => {
    const text = di();
    expect(text).toMatch(/\.env/);
    expect(text).toMatch(/\*\.key/);
    expect(text).toMatch(/\*\.pem/);
    expect(text).toMatch(/\.claude/);
  });
});

describe('docker-compose.yml — backend service, persistence, env', () => {
  const dc = (): string => read('docker-compose.yml');

  it('defines a backend service that builds the local Dockerfile', () => {
    const text = dc();
    expect(text).toMatch(/^\s{2,}backend:/m);
    expect(text).toMatch(/build:/);
  });

  it('pins the build/run target to linux/amd64', () => {
    expect(dc()).toMatch(/platform:\s*linux\/amd64/);
  });

  it('publishes only on the loopback interface (127.0.0.1:8000:8000)', () => {
    expect(dc()).toMatch(/127\.0\.0\.1:8000:8000/);
  });

  it('mounts a named volume kgpacks-data at /data and declares it', () => {
    const text = dc();
    expect(text).toMatch(/kgpacks-data:\/data/);
    expect(text).toMatch(/^volumes:/m);
    expect(text).toMatch(/^\s+kgpacks-data:/m);
  });

  it('wires the required WIKIGR_* environment for the container', () => {
    const text = dc();
    expect(text).toMatch(/WIKIGR_HOST[:=]\s*['"]?0\.0\.0\.0/);
    expect(text).toMatch(/WIKIGR_PORT[:=]\s*['"]?8000/);
    expect(text).toMatch(/WIKIGR_DATABASE_PATH[:=]\s*['"]?\/data\/kgpacks\.db/);
  });

  it('forwards optional BYOK keys with safe ${VAR:-} pass-through (never baked in)', () => {
    const text = dc();
    expect(text).toMatch(/\$\{COPILOT_API_KEY:-\s*\}/);
    expect(text).toMatch(/\$\{OPENAI_API_KEY:-\s*\}/);
    expect(text).toMatch(/\$\{ANTHROPIC_API_KEY:-\s*\}/);
  });
});

describe('docker-compose.yml — healthcheck and container hardening', () => {
  const dc = (): string => read('docker-compose.yml');

  it('health-checks /health using Node fetch (no curl/wget in the image)', () => {
    const text = dc();
    expect(text).toMatch(/healthcheck:/);
    expect(text).toMatch(/fetch\(/);
    expect(text).toMatch(/\/health/);
    expect(text).not.toMatch(/\b(curl|wget)\b/);
  });

  it('applies container hardening (read-only rootfs, tmpfs, cap_drop, no-new-privileges)', () => {
    const text = dc();
    expect(text).toMatch(/read_only:\s*true/);
    expect(text).toMatch(/tmpfs:/);
    expect(text).toMatch(/cap_drop:/);
    expect(text).toMatch(/no-new-privileges:true/);
  });
});

describe('docs/deployment.md — operator guide content', () => {
  const doc = (): string => read('docs/deployment.md');

  it('documents the GLIBC / no-Alpine requirement and its rationale', () => {
    const text = doc();
    expect(text).toMatch(/GLIBC/i);
    expect(text).toMatch(/alpine/i);
    expect(text).toMatch(/musl/i);
  });

  it('documents the VECTOR / FTS extension first-load network behavior', () => {
    const text = doc();
    expect(text).toMatch(/VECTOR/);
    expect(text).toMatch(/FTS/);
    expect(text).toMatch(/extension/i);
    expect(text).toMatch(/HTTPS|443|egress/i);
  });

  it('documents the WIKIGR_* environment contract', () => {
    const text = doc();
    expect(text).toMatch(/WIKIGR_DATABASE_PATH/);
    expect(text).toMatch(/WIKIGR_HOST/);
    expect(text).toMatch(/WIKIGR_PORT/);
  });

  it('documents version pinning (Node 22, pnpm 9.15.0, @ladybugdb/core 0.17.1)', () => {
    const text = doc();
    expect(text).toMatch(/Node(\.js)?\b[^\n]*22|node:22/);
    expect(text).toMatch(/pnpm@?9\.15\.0/);
    expect(text).toMatch(/@ladybugdb\/core[^\n]*0\.17\.1/);
  });
});

describe('CI — docker-image job builds and asserts a Python-free image', () => {
  const ci = (): string => read('.github/workflows/ci.yml');

  it('adds a docker-image job', () => {
    expect(ci()).toMatch(/^\s+docker-image:/m);
  });

  it('builds the image to catch Dockerfile breakage', () => {
    expect(ci()).toMatch(/docker\s+build/);
  });

  it('asserts the final image contains no Python', () => {
    const text = ci();
    expect(text).toMatch(/command\s+-v\s+python3?/);
  });

  it('asserts the native @ladybugdb/core binding loads inside the image', () => {
    expect(ci()).toMatch(/require\((['"])@ladybugdb\/core\1\)/);
  });

  it('asserts the runtime user is non-root', () => {
    expect(ci()).toMatch(/\b(id\s+-u|whoami)\b/);
  });
});

describe('CI — existing jobs and supply-chain pinning are preserved', () => {
  const ci = (): string => read('.github/workflows/ci.yml');

  it('keeps the existing build and python-free-guard jobs on Node 22', () => {
    const text = ci();
    expect(text).toMatch(/^\s+build:/m);
    expect(text).toMatch(/^\s+python-free-guard:/m);
    expect(text).toMatch(/node-version:\s*22/);
    expect(text).toMatch(/check-no-python\.mjs/);
  });

  it('introduces no unpinned GitHub Action (only SHA-pinned actions/checkout)', () => {
    const text = ci();
    // Every `uses:` reference must be pinned to a 40-hex commit SHA.
    const uses = text.match(/uses:\s*\S+/g) ?? [];
    for (const u of uses) {
      expect(u).toMatch(/@[0-9a-f]{40}\b/);
    }
    // No setup-buildx-action (the doc's explicit supply-chain caveat).
    expect(text).not.toMatch(/setup-buildx-action/);
  });
});
