import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
