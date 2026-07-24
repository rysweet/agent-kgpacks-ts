import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXIT_OK, EXIT_VALIDATION } from '../src/exit-codes.js';
import { parseStdout, runCli } from './helpers/run-cli.js';

const { validateKnowledgePack } = vi.hoisted(() => ({
  validateKnowledgePack: vi.fn(async () => ({
    counts: { articles: 1, sections: 1, chunks: 1, entities: 1, relationships: 0 },
  })),
}));

vi.mock('@kgpacks/ingestion', () => ({ validateKnowledgePack }));

describe('pack validate manifest schema dispatch', () => {
  let root: string;
  let packsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kgpacks-schema-dispatch-'));
    packsDir = join(root, 'packs');
    mkdirSync(packsDir);
    validateKnowledgePack.mockClear();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function validate(schema: { present: false } | { present: true; value: unknown }) {
    const name = 'schema-pack';
    const dir = join(packsDir, name);
    mkdirSync(dir);
    const manifest: Record<string, unknown> = { name, version: '1.2.3' };
    if (schema.present) manifest.schemaVersion = schema.value;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'pack.db'), '');
    return runCli(['pack', 'validate', name], { packsDir });
  }

  it.each([
    ['an absent property', { present: false } as const],
    ['legacy string "1"', { present: true, value: '1' } as const],
  ])('accepts %s as a legacy manifest', async (_label, schema) => {
    const result = await validate(schema);
    expect(result.code).toBe(EXIT_OK);
    expect(parseStdout(result)).toMatchObject({ valid: true, name: 'schema-pack' });
    expect(validateKnowledgePack).not.toHaveBeenCalled();
  });

  it('dispatches string "2" to comprehensive knowledge-pack validation', async () => {
    const result = await validate({ present: true, value: '2' });
    expect(result.code).toBe(EXIT_OK);
    expect(validateKnowledgePack).toHaveBeenCalledTimes(1);
    expect(parseStdout(result)).toMatchObject({ valid: true, name: 'schema-pack' });
  });

  it.each([
    ['null', null],
    ['numeric 1', 1],
    ['numeric 2', 2],
    ['an unknown string', '3'],
    ['an empty string', ''],
    ['a boolean', true],
    ['an object', { version: '2' }],
    ['an array', ['2']],
  ])('rejects %s with exit code 4', async (_label, value) => {
    const result = await validate({ present: true, value });
    expect(result.code).toBe(EXIT_VALIDATION);
    expect(result.stderr).toMatch(/unsupported manifest schema/i);
    expect(validateKnowledgePack).not.toHaveBeenCalled();
  });
});
