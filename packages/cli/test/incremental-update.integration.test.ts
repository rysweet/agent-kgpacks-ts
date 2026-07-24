import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildCvePack,
  type Embedder,
  updateKnowledgePack,
  validateKnowledgePack,
} from '@kgpacks/ingestion';
import { expect, it } from 'vitest';

import { EXIT_OK } from '../src/exit-codes.js';
import { parseStdout, runCli } from './helpers/run-cli.js';

const embedder: Embedder = {
  modelId: 'test-deterministic-embedder-v1',
  async generate(texts) {
    return texts.map((text) => {
      const digest = createHash('sha256').update(text).digest();
      return Float32Array.from({ length: 768 }, (_, index) => (digest[index % 32] + 1) / 256);
    });
  },
};

it('drives the real CVE update engine through the public CLI', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'kgpacks-cli-update-e2e-'));
  const fixtures = resolve(import.meta.dirname, '../../../test/fixtures/cve-update');
  const base = join(temp, 'base');
  const output = join(temp, 'output');
  try {
    await buildCvePack({
      source: join(fixtures, 'base.ndjson'),
      output: base,
      packId: 'cve-fixture',
      version: '1.0.0',
      embedder,
      corpusCommit: '0123456789abcdef0123456789abcdef01234567',
      corpusDate: '2026-07-03',
      corpusTag: 'cve_2026-07-03_0000Z',
    });
    const result = await runCli(
      [
        'update',
        '--base',
        base,
        '--delta',
        join(fixtures, 'delta.ndjson'),
        '--output',
        output,
        '--version',
        '2.0.0',
      ],
      {
        updateKnowledgePack: (config) => updateKnowledgePack({ ...config, embedder }),
      },
    );
    expect(result.code, result.stderr).toBe(EXIT_OK);
    expect(parseStdout(result)).toMatchObject({
      packId: 'cve-fixture',
      added: 1,
      modified: 1,
      unchanged: 1,
    });
    expect(await validateKnowledgePack(output)).toMatchObject({
      valid: true,
      counts: { articles: 3 },
    });
    const validation = await runCli(['--packs-dir', temp, 'pack', 'validate', 'output'], {});
    expect(validation.code).toBe(EXIT_OK);
    expect(parseStdout(validation)).toMatchObject({
      valid: true,
      name: 'cve-fixture',
      counts: { articles: 3 },
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 30_000);

it('falls back to manifest validation for a legacy pack without schema-v2 payloads', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'kgpacks-cli-legacy-'));
  try {
    const legacy = join(temp, 'legacy');
    mkdirSync(legacy);
    writeFileSync(
      join(legacy, 'manifest.json'),
      `${JSON.stringify({ name: 'legacy', version: '1.2.3' }, null, 2)}\n`,
    );
    const result = await runCli(['--packs-dir', temp, 'pack', 'validate', 'legacy'], {});
    expect(result.code, result.stderr).toBe(EXIT_OK);
    expect(parseStdout(result)).toEqual({ valid: true, name: 'legacy', version: '1.2.3' });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it('rejects unsupported manifest schema versions', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'kgpacks-cli-unknown-schema-'));
  try {
    const pack = join(temp, 'unknown');
    mkdirSync(pack);
    writeFileSync(
      join(pack, 'manifest.json'),
      `${JSON.stringify({ name: 'unknown', version: '1.2.3', schemaVersion: '999' }, null, 2)}\n`,
    );
    const result = await runCli(['--packs-dir', temp, 'pack', 'validate', 'unknown'], {});
    expect(result.code).not.toBe(EXIT_OK);
    expect(result.stderr).toMatch(/unsupported manifest schema version/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
