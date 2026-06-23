// packages/cli/test/create.integration.test.ts
//
// Offline end-to-end integration for `create`: drives the CLI with the REAL
// `@kgpacks/ingestion` `buildPack`, but with every external seam mocked —
// `fetcher` (canned HTML), `embedder` (deterministic vectors), `extractor` (fixed
// result) — and a caller-owned in-memory `@kgpacks/db` connection. After the run we
// query that same connection to assert the pack was actually loaded, and check the
// process exit code. No network, no model, no disk database.
//
// This is the cross-package contract the unit tests (which inject a *fake*
// buildPack) cannot cover; it requires the implementation to wire `create` to the
// injectable `buildPack` seam and forward the pack's `dbPath`/seeds/bounds.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database, type Connection } from '@kgpacks/db';
import { EMBEDDING_DIM, buildPack as realBuildPack } from '@kgpacks/ingestion';
import type {
  BuildPackConfig,
  BuildPackResult,
  Embedder,
  ExtractionResult,
  Extractor,
} from '@kgpacks/ingestion';

import { parseStdout, runCli } from './helpers/run-cli.js';

const SEED_URL = 'https://en.wikipedia.org/wiki/Tiny';

/** A minimal Wikipedia-ish page: a lead paragraph + one `History` section. */
function wikiHtml(title: string, lead: string): string {
  return [
    `<html><head><title>${title} - Wikipedia</title></head><body>`,
    `<p>${lead}</p>`,
    `<h2>History</h2><p>Some historical background about ${title}.</p>`,
    `</body></html>`,
  ].join('');
}

/** Canned-HTML fetcher keyed by exact URL (unknown URLs reject, like the real seam). */
function mockFetcher(pages: Record<string, string>): (url: string) => Promise<string> {
  return async (url: string): Promise<string> => {
    const html = pages[url];
    if (html === undefined) {
      throw new Error(`no canned page for ${url}`);
    }
    return html;
  };
}

/** Deterministic, offline document embedder producing valid 768-dim unit vectors. */
function mockEmbedder(): Embedder {
  const hashToIndex = (text: string): number => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % EMBEDDING_DIM;
  };
  return {
    async generate(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const v = new Float32Array(EMBEDDING_DIM);
        v[hashToIndex(t)] = 1;
        return v;
      });
    },
  };
}

/** An extractor returning one fixed entity for every article. */
function mockExtractor(): Extractor {
  const result: ExtractionResult = {
    entities: [{ name: 'Tiny Concept', type: 'concept' }],
    relationships: [],
    keyFacts: ['a fact'],
  };
  return {
    async extract(): Promise<ExtractionResult> {
      return result;
    },
  };
}

let base: string;
let packsDir: string;
let db: Database;
let connection: Connection;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kgpacks-cli-create-'));
  packsDir = join(base, 'packs');
  db = new Database();
  connection = db.connect();
});

afterEach(() => {
  connection.close();
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe('create — offline integration with the real buildPack', () => {
  it('runs the pipeline, loads the in-memory pack, and exits 0', async () => {
    const fetcher = mockFetcher({
      [SEED_URL]: wikiHtml('Tiny', 'Tiny is a small topic.'),
    });
    const embedder = mockEmbedder();
    const extractor = mockExtractor();

    const dbPath = join(packsDir, 'tiny', 'pack.db');

    // The seam wrapper supplies the mocked seams + caller-owned connection, exactly
    // as documented in the package README's programmatic-use example.
    const buildPack = (config: BuildPackConfig): Promise<BuildPackResult> =>
      realBuildPack({ ...config, fetcher, embedder, extractor, connection });

    const result = await runCli(['create', '--pack', 'tiny', '--seeds', SEED_URL], {
      packsDir,
      buildPack,
    });

    expect(result.code).toBe(0);

    const out = parseStdout(result) as Record<string, number | string>;
    expect(out.pack).toBe('tiny');
    expect(out.dbPath).toBe(dbPath);
    expect(out.articles).toBe(1);
    expect(out.sections).toBe(2); // lead + History
    expect(out.entities).toBe(1);
    expect(out.relationships).toBe(0);
    expect(out.links).toBe(0);
    expect(out.chunks as number).toBeGreaterThanOrEqual(2);

    // The destination pack directory was created on disk.
    expect(existsSync(join(packsDir, 'tiny'))).toBe(true);

    // The pack is genuinely queryable through the caller-owned connection.
    const rows = await connection.run<{ id: string }>(`MATCH (s:Section) RETURN s.id AS id`);
    expect(rows.map((r) => r.id).sort()).toEqual(['Tiny#0', 'Tiny#1']);
  });
});
