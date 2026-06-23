// test/scaffold.test.ts
//
// Structural / integration contract for the Phase 0 monorepo scaffold.
//
// Encodes the deliverables from docs/monorepo.md and docs/PLAN.md as executable
// assertions: workspace wiring, root tooling configs, and the nine uniform
// @kgpacks/* package skeletons. These FAIL today (nothing under packages/ exists,
// no root configs) and PASS once the scaffold is in place.
//
// Run by the ROOT vitest config (include test/**). Pure filesystem checks — no
// imports of source, no new dependencies.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');
const exists = (rel: string): boolean => existsSync(join(repoRoot, rel));
const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(read(rel)) as Record<string, unknown>;

// The nine packages mandated by Phase 0 (docs/PLAN.md Default Stack).
const PACKAGES = [
  'db',
  'embeddings',
  'agent',
  'query',
  'packs',
  'backend',
  'cli',
  'mcp',
  'eval',
] as const;

describe('scaffold — workspace wiring', () => {
  it('declares a pnpm workspace covering packages/*', () => {
    expect(exists('pnpm-workspace.yaml')).toBe(true);
    expect(read('pnpm-workspace.yaml')).toMatch(/packages\/\*/);
  });

  it('commits a pnpm lockfile for reproducible installs', () => {
    expect(exists('pnpm-lock.yaml')).toBe(true);
  });

  it('does NOT scaffold the Phase 2 / migration-only members', () => {
    // @kgpacks/ingestion (Phase 2) and frontend are intentionally absent now.
    expect(exists('packages/ingestion')).toBe(false);
    expect(exists('packages/frontend')).toBe(false);
  });
});

describe('scaffold — root package.json', () => {
  const pkg = (): Record<string, unknown> => readJson('package.json');

  it('is a private ESM root pinned to Node 22+ and an exact pnpm version', () => {
    const p = pkg();
    expect(p.private).toBe(true);
    expect(p.type).toBe('module');
    expect((p.engines as Record<string, string>).node).toMatch(/22/);
    expect(String(p.packageManager)).toMatch(/^pnpm@9\.\d+\.\d+$/);
  });

  it('fans build/test/typecheck across the workspace and exposes lint + format', () => {
    const scripts = pkg().scripts as Record<string, string>;
    expect(scripts.build).toMatch(/pnpm -r build/);
    expect(scripts.test).toMatch(/pnpm -r test/);
    expect(scripts.typecheck).toBeTruthy();
    expect(scripts.lint).toMatch(/eslint/);
    expect(scripts['format:check']).toMatch(/prettier/);
  });
});

describe('scaffold — shared TypeScript base config', () => {
  it('tsconfig.base.json enforces strict, modern, ESM-first settings', () => {
    expect(exists('tsconfig.base.json')).toBe(true);
    const text = read('tsconfig.base.json');
    expect(text).toMatch(/"strict"\s*:\s*true/);
    expect(text).toMatch(/"module"\s*:\s*"NodeNext"/);
    expect(text).toMatch(/"moduleResolution"\s*:\s*"NodeNext"/);
    expect(text).toMatch(/"declaration"\s*:\s*true/);
  });
});

describe('scaffold — root tooling files', () => {
  it.each([
    'eslint.config.js',
    '.prettierrc',
    'vitest.config.ts',
    '.npmrc',
    'scripts/check-no-python.mjs',
    '.github/workflows/ci.yml',
  ])('provides %s', (rel) => {
    expect(exists(rel)).toBe(true);
  });
});

describe('scaffold — CI workflow', () => {
  it('runs install, typecheck, lint, build, test and the python-free guard on Node 22', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/22/); // Node 22
    expect(ci).toMatch(/pnpm install/);
    expect(ci).toMatch(/typecheck/);
    expect(ci).toMatch(/lint/);
    expect(ci).toMatch(/build/);
    expect(ci).toMatch(/test/);
    expect(ci).toMatch(/check-no-python\.mjs/);
  });
});

describe.each(PACKAGES)('scaffold — package @kgpacks/%s', (name) => {
  const dir = `packages/${name}`;

  it('exists with package.json, tsconfig.json, README.md, and src/index.ts', () => {
    expect(exists(dir)).toBe(true);
    expect(exists(`${dir}/package.json`)).toBe(true);
    expect(exists(`${dir}/tsconfig.json`)).toBe(true);
    expect(exists(`${dir}/README.md`)).toBe(true);
    expect(exists(`${dir}/src/index.ts`)).toBe(true);
  });

  it('package.json is named @kgpacks/<name>, ESM, with build/test/typecheck scripts', () => {
    const p = readJson(`${dir}/package.json`);
    expect(p.name).toBe(`@kgpacks/${name}`);
    expect(p.type).toBe('module');
    const scripts = (p.scripts ?? {}) as Record<string, string>;
    expect(scripts.build).toMatch(/tsc/);
    expect(scripts.test).toMatch(/vitest/);
    expect(scripts.typecheck).toMatch(/tsc/);
  });

  it('tsconfig.json extends the shared base and emits to dist/ from src/', () => {
    const text = read(`${dir}/tsconfig.json`);
    expect(text).toMatch(/tsconfig\.base\.json/);
    const cfg = JSON.parse(text) as { compilerOptions?: Record<string, unknown> };
    expect(cfg.compilerOptions?.outDir).toBe('dist');
    expect(cfg.compilerOptions?.rootDir).toBe('src');
  });
});

describe('scaffold — third-party runtime dependency pins', () => {
  it('pins @ladybugdb/core to an exact 0.17.1 (no range) as a runtime dependency', () => {
    const p = readJson('packages/db/package.json');
    const deps = (p.dependencies ?? {}) as Record<string, string>;
    expect(deps['@ladybugdb/core']).toBe('0.17.1');
  });

  it('@kgpacks/embeddings carries @huggingface/transformers as its only third-party runtime dependency', () => {
    const p = readJson('packages/embeddings/package.json');
    const deps = (p.dependencies ?? {}) as Record<string, string>;
    expect(deps['@huggingface/transformers']).toBeDefined();
    const external = Object.keys(deps).filter((d) => !d.startsWith('@kgpacks/'));
    expect(external).toEqual(['@huggingface/transformers']);
  });

  it('@kgpacks/agent carries @github/copilot-sdk as its only third-party runtime dependency', () => {
    const p = readJson('packages/agent/package.json');
    const deps = (p.dependencies ?? {}) as Record<string, string>;
    expect(deps['@github/copilot-sdk']).toBeDefined();
    expect(deps['@github/copilot-sdk']).toBe('1.0.3');
    const external = Object.keys(deps).filter((d) => !d.startsWith('@kgpacks/'));
    expect(external).toEqual(['@github/copilot-sdk']);
  });

  it('@kgpacks/mcp carries the MCP SDK and zod as its only third-party runtime dependencies', () => {
    // Phase 1: @kgpacks/mcp implements the MCP server, so it now legitimately
    // depends on the TypeScript MCP SDK (and zod for its tool input schemas).
    // These are its ONLY non-@kgpacks runtime dependencies.
    const p = readJson('packages/mcp/package.json');
    const deps = (p.dependencies ?? {}) as Record<string, string>;
    expect(deps['@modelcontextprotocol/sdk']).toBeDefined();
    expect(deps['zod']).toBeDefined();
    const external = Object.keys(deps).filter((d) => !d.startsWith('@kgpacks/'));
    expect(external.sort()).toEqual(['@modelcontextprotocol/sdk', 'zod']);
  });

  it('@kgpacks/cli carries commander as its only third-party runtime dependency', () => {
    // Phase 1: @kgpacks/cli implements the `wikigr` command-line interface, so it
    // now legitimately depends on commander for argument parsing. That is its ONLY
    // non-@kgpacks runtime dependency.
    const p = readJson('packages/cli/package.json');
    const deps = (p.dependencies ?? {}) as Record<string, string>;
    expect(deps['commander']).toBeDefined();
    const external = Object.keys(deps).filter((d) => !d.startsWith('@kgpacks/'));
    expect(external).toEqual(['commander']);
  });

  it('no package other than db, embeddings, agent, mcp and cli carries a third-party runtime dependency', () => {
    const allowed = new Set(['db', 'embeddings', 'agent', 'mcp', 'cli']);
    for (const name of PACKAGES) {
      if (allowed.has(name)) continue;
      const p = readJson(`packages/${name}/package.json`);
      const deps = (p.dependencies ?? {}) as Record<string, string>;
      const external = Object.keys(deps).filter((d) => !d.startsWith('@kgpacks/'));
      expect(external).toEqual([]);
    }
  });
});
