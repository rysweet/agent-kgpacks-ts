import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { Database } from '@kgpacks/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertExactVectorIdentityClosure } from '../src/incremental-update.js';
import {
  buildCvePack,
  resolveCorpusProvenance,
  type Embedder,
  updateKnowledgePack,
  validateKnowledgePack,
} from '../src/index.js';

const FIXTURES = resolve(import.meta.dirname, '../../../test/fixtures/cve-update');
const BASE_SOURCE = join(FIXTURES, 'base.ndjson');
const DELTA = join(FIXTURES, 'delta.ndjson');
const CORPUS_PROVENANCE = {
  corpusCommit: '0123456789abcdef0123456789abcdef01234567',
  corpusDate: '2026-07-03',
  corpusTag: 'cve_2026-07-03_0000Z',
} as const;

const embedder: Embedder = {
  modelId: 'test-deterministic-embedder-v1',
  async generate(texts) {
    return texts.map((text) => {
      const out = new Float32Array(768);
      const digest = createHash('sha256').update(text).digest();
      for (let i = 0; i < out.length; i++) out[i] = (digest[i % digest.length] + 1) / 256;
      return out;
    });
  },
};

function treeDigest(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        hash.update(path.slice(dir.length));
        hash.update(readFileSync(path));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function rows<T>(packDir: string, cypher: string): Promise<T[]> {
  const db = new Database(join(packDir, 'pack.db'), { readOnly: true });
  const conn = db.connect();
  try {
    if (cypher.includes('QUERY_VECTOR_INDEX')) await conn.loadExtension('vector');
    return await conn.run<T>(cypher);
  } finally {
    conn.close();
    db.close();
  }
}

async function logicalPackDigest(packDir: string): Promise<string> {
  const db = new Database(join(packDir, 'pack.db'), { readOnly: true });
  const conn = db.connect();
  try {
    const graph = {
      articles: await conn.run(
        'MATCH (a:Article) RETURN a.title AS title, a.category AS category ORDER BY title',
      ),
      sections: await conn.run(
        'MATCH (s:Section) RETURN s.id AS id, s.content AS content, s.embedding AS embedding ORDER BY id',
      ),
      chunks: await conn.run(
        'MATCH (c:Chunk) RETURN c.id AS id, c.content AS content, c.embedding AS embedding ORDER BY id',
      ),
      entities: await conn.run(
        'MATCH (e:Entity) RETURN e.entity_id AS id, e.type AS type ORDER BY id',
      ),
      sources: await conn.run(
        'MATCH (s:ArticleSource) RETURN s.title AS title, s.payload AS payload, ' +
          's.payload_sha256 AS hash ORDER BY title',
      ),
      support: await conn.run(
        'MATCH (s:RelationSupport) RETURN s.article_title AS article, s.signature AS signature ' +
          'ORDER BY article, signature',
      ),
    };
    return createHash('sha256').update(JSON.stringify(graph)).digest('hex');
  } finally {
    conn.close();
    db.close();
  }
}

describe('incremental CVE pack update', () => {
  const temp = mkdtempSync(join(tmpdir(), 'kgpacks-update-'));
  const base = join(temp, 'cve-fixture');
  const output = join(temp, 'cve-v2');
  let baseDigest: string;

  beforeAll(async () => {
    await buildCvePack({
      source: BASE_SOURCE,
      output: base,
      packId: 'cve-fixture',
      version: '1.0.0',
      embedder,
      ...CORPUS_PROVENANCE,
    });
    baseDigest = treeDigest(base);
  });

  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it('publishes exact schema-v2 corpus provenance and rejects substitutions', () => {
    const releaseScript = resolve(import.meta.dirname, '../../../scripts/release-pack.mjs');
    const releaseDir = join(temp, 'release-provenance');
    execFileSync(
      'node',
      [
        releaseScript,
        '--pack',
        'cve-fixture',
        '--packs-dir',
        temp,
        '--out-dir',
        releaseDir,
        '--dry-run',
      ],
      { stdio: 'ignore' },
    );
    const index = JSON.parse(
      readFileSync(join(releaseDir, 'cve-fixture.pack-release.json'), 'utf8'),
    );
    expect(index.provenance).toEqual(
      JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8')).provenance,
    );

    const mismatch = spawnSync(
      'node',
      [
        releaseScript,
        '--pack',
        'cve-fixture',
        '--packs-dir',
        temp,
        '--corpus-commit',
        'substituted',
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    expect(mismatch.status).toBe(2);
    expect(mismatch.stderr).toMatch(/must exactly match schema-v2 manifest provenance/i);
  });

  it('rejects non-commit provenance and impossible UTC dates before creating output', async () => {
    for (const [name, provenance] of [
      ['tag', { ...CORPUS_PROVENANCE, corpusCommit: CORPUS_PROVENANCE.corpusTag }],
      ['abbreviated', { ...CORPUS_PROVENANCE, corpusCommit: '01234567' }],
      ['unknown', { ...CORPUS_PROVENANCE, corpusCommit: 'unknown' }],
      ['impossible-date', { ...CORPUS_PROVENANCE, corpusDate: '2025-02-29' }],
    ] as const) {
      const invalidOutput = join(temp, `invalid-provenance-${name}`);
      await expect(
        buildCvePack({
          source: BASE_SOURCE,
          output: invalidOutput,
          packId: 'cve-invalid-provenance',
          version: '1.0.0',
          embedder,
          ...provenance,
        }),
      ).rejects.toThrow(/corpus (commit|date)/i);
      expect(existsSync(invalidOutput)).toBe(false);
    }
  });

  it('uses a strict fetched-corpus sidecar as the canonical provenance authority', async () => {
    const fetchedRoot = join(temp, 'fetched-corpus');
    const fetchedSource = join(fetchedRoot, 'extracted', 'cves', 'records.ndjson');
    mkdirSync(join(fetchedRoot, 'extracted', 'cves'), { recursive: true });
    writeFileSync(fetchedSource, readFileSync(BASE_SOURCE));
    writeFileSync(
      join(fetchedRoot, 'corpus-provenance.json'),
      `${JSON.stringify(
        {
          corpus: {
            name: 'cvelistV5',
            commit: CORPUS_PROVENANCE.corpusCommit,
            date: CORPUS_PROVENANCE.corpusDate,
            tag: CORPUS_PROVENANCE.corpusTag,
            kind: 'baseline',
            asset: 'all_CVEs_at_midnight.zip.zip',
          },
          fetched_at: '2026-07-03T01:20:00.000Z',
        },
        null,
        2,
      )}\n`,
    );

    expect(resolveCorpusProvenance(fetchedSource, {})).toEqual({
      commit: CORPUS_PROVENANCE.corpusCommit,
      date: CORPUS_PROVENANCE.corpusDate,
      tag: CORPUS_PROVENANCE.corpusTag,
    });
    const sidecarOutput = join(temp, 'sidecar-provenance-pack');
    await buildCvePack({
      source: fetchedSource,
      output: sidecarOutput,
      packId: 'cve-sidecar',
      version: '1.0.0',
      embedder,
    });
    expect((await validateKnowledgePack(sidecarOutput)).metadata.provenance).toMatchObject({
      corpus: {
        commit: CORPUS_PROVENANCE.corpusCommit,
        date: CORPUS_PROVENANCE.corpusDate,
        tag: CORPUS_PROVENANCE.corpusTag,
      },
    });

    const mismatchOutput = join(temp, 'sidecar-mismatch-pack');
    await expect(
      buildCvePack({
        source: fetchedSource,
        output: mismatchOutput,
        packId: 'cve-sidecar-mismatch',
        version: '1.0.0',
        embedder,
        corpusCommit: 'f'.repeat(40),
      }),
    ).rejects.toThrow(/does not match authoritative corpus-provenance\.json/i);
    expect(existsSync(mismatchOutput)).toBe(false);
  });

  it('rejects malformed sidecars and incomplete manual provenance before output', async () => {
    const malformedRoot = join(temp, 'malformed-corpus');
    const malformedSource = join(malformedRoot, 'records.ndjson');
    mkdirSync(malformedRoot);
    writeFileSync(malformedSource, readFileSync(BASE_SOURCE));
    writeFileSync(join(malformedRoot, 'corpus-provenance.json'), '{"corpus":');
    const malformedOutput = join(temp, 'malformed-provenance-pack');
    await expect(
      buildCvePack({
        source: malformedSource,
        output: malformedOutput,
        packId: 'cve-malformed-provenance',
        version: '1.0.0',
        embedder,
        ...CORPUS_PROVENANCE,
      }),
    ).rejects.toThrow(/invalid corpus provenance sidecar/i);
    expect(existsSync(malformedOutput)).toBe(false);

    writeFileSync(
      join(malformedRoot, 'corpus-provenance.json'),
      JSON.stringify({
        corpus: {
          name: 'cvelistV5',
          commit: CORPUS_PROVENANCE.corpusCommit,
          date: CORPUS_PROVENANCE.corpusDate,
          tag: CORPUS_PROVENANCE.corpusTag,
          kind: 'baseline',
        },
        fetched_at: '2026-07-03T01:20:00.000Z',
      }),
    );
    const missingFieldOutput = join(temp, 'missing-field-provenance-pack');
    await expect(
      buildCvePack({
        source: malformedSource,
        output: missingFieldOutput,
        packId: 'cve-missing-field-provenance',
        version: '1.0.0',
        embedder,
        ...CORPUS_PROVENANCE,
      }),
    ).rejects.toThrow(/invalid corpus provenance sidecar/i);
    expect(existsSync(missingFieldOutput)).toBe(false);

    const incompleteOutput = join(temp, 'incomplete-provenance-pack');
    await expect(
      buildCvePack({
        source: BASE_SOURCE,
        output: incompleteOutput,
        packId: 'cve-incomplete-provenance',
        version: '1.0.0',
        embedder,
      }),
    ).rejects.toThrow(/complete corpus provenance is required/i);
    expect(existsSync(incompleteOutput)).toBe(false);
  });

  it('requires unique bidirectional vector-index identity closure', () => {
    expect(() =>
      assertExactVectorIdentityClosure(['a', 'b'], ['b', 'a'], 'embedding_idx', 'Section'),
    ).not.toThrow();
    expect(() =>
      assertExactVectorIdentityClosure(['a', 'b'], ['a'], 'embedding_idx', 'Section'),
    ).toThrow(/does not match/i);
    expect(() =>
      assertExactVectorIdentityClosure(['a'], ['a', 'stale'], 'embedding_idx', 'Section'),
    ).toThrow(/does not match/i);
    expect(() =>
      assertExactVectorIdentityClosure(['a', 'b'], ['a', 'c'], 'embedding_idx', 'Section'),
    ).toThrow(/does not match/i);
    expect(() =>
      assertExactVectorIdentityClosure(['a', 'b'], ['a', 'a'], 'embedding_idx', 'Section'),
    ).toThrow(/duplicate/i);
    expect(() =>
      assertExactVectorIdentityClosure(['a', 'a'], ['a'], 'embedding_idx', 'Section'),
    ).toThrow(/duplicate/i);
    expect(() =>
      assertExactVectorIdentityClosure([], ['stale'], 'chunk_embedding_idx', 'Chunk'),
    ).toThrow(/does not match/i);
    expect(() =>
      assertExactVectorIdentityClosure([], [], 'chunk_embedding_idx', 'Chunk'),
    ).not.toThrow();
  });

  it('canonicalizes object keys by Unicode scalar value', async () => {
    const source = join(temp, 'unicode-source.ndjson');
    const record = JSON.parse(readFileSync(BASE_SOURCE, 'utf8').split('\n')[0]);
    record['\uE000'] = 'private-use';
    record['😀'] = 'astral';
    writeFileSync(source, `${JSON.stringify(record)}\n`);
    const unicodePack = join(temp, 'unicode-pack');

    await buildCvePack({
      source,
      output: unicodePack,
      packId: 'cve-unicode',
      version: '1.0.0',
      embedder,
      ...CORPUS_PROVENANCE,
    });

    const sources = await rows<{ payload: string }>(
      unicodePack,
      'MATCH (s:ArticleSource) RETURN s.payload AS payload',
    );
    expect(sources[0].payload.indexOf('"\uE000"')).toBeLessThan(sources[0].payload.indexOf('"😀"'));
  });

  it('isolates concurrent full-build staging and publishes exactly one output', async () => {
    const concurrentOutput = join(temp, 'concurrent-base');
    const builds = await Promise.allSettled([
      buildCvePack({
        source: BASE_SOURCE,
        output: concurrentOutput,
        packId: 'cve-concurrent',
        version: '1.0.0',
        embedder,
        ...CORPUS_PROVENANCE,
      }),
      buildCvePack({
        source: BASE_SOURCE,
        output: concurrentOutput,
        packId: 'cve-concurrent',
        version: '1.0.0',
        embedder,
        ...CORPUS_PROVENANCE,
      }),
    ]);

    expect(builds.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(builds.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(validateKnowledgePack(concurrentOutput)).resolves.toMatchObject({ valid: true });
  });

  it('adds, replaces, preserves, rebuilds indexes, and records immutable lineage', async () => {
    writeFileSync(`${output}.build-checkpoint.json`, '{"sourceOffset":999}\n');
    const result = await updateKnowledgePack({
      base,
      delta: DELTA,
      output,
      version: '2.0.0',
      embedder,
    });

    expect(result).toMatchObject({
      packId: 'cve-fixture',
      version: '2.0.0',
      added: 1,
      modified: 1,
      unchanged: 1,
    });
    expect(treeDigest(base)).toBe(baseDigest);
    expect(existsSync(`${output}.build-checkpoint.json`)).toBe(true);

    const articles = await rows<{ title: string }>(
      output,
      'MATCH (a:Article) RETURN a.title AS title ORDER BY title',
    );
    expect(articles.map((row) => row.title)).toEqual([
      'CVE-2025-1000',
      'CVE-2025-1001',
      'CVE-2025-1002',
    ]);

    const content = await rows<{ id: string; content: string }>(
      output,
      'MATCH (s:Section) RETURN s.id AS id, s.content AS content ORDER BY id',
    );
    expect(content.find((row) => row.id === 'CVE-2025-1001#0')?.content).toContain(
      'no longer affects the retired legacy component',
    );
    expect(content.some((row) => row.content.includes('SQL Injection'))).toBe(false);

    const entities = await rows<{ id: string }>(
      output,
      'MATCH (e:Entity) RETURN e.entity_id AS id ORDER BY id',
    );
    expect(entities.map((row) => row.id)).not.toContain('LegacyWidget');
    expect(entities.map((row) => row.id)).not.toContain('CWE-89');
    expect(entities.map((row) => row.id)).toEqual(
      expect.arrayContaining(['Acme', 'SharedWidget', 'CWE-79', 'NewWidget']),
    );

    const sharedSupport = await rows<{ article: string }>(
      output,
      "MATCH (p:RelationSupport) WHERE p.source_entity_id = 'SharedWidget' " +
        "AND p.target_entity_id = 'Acme' AND p.relation = 'made_by' AND p.context = '' " +
        'RETURN p.article_title AS article ORDER BY article',
    );
    expect(sharedSupport.map((row) => row.article)).toEqual(['CVE-2025-1000', 'CVE-2025-1001']);
    const sharedRelations = await rows<{ count: number | bigint }>(
      output,
      "MATCH (a:Entity {entity_id: 'SharedWidget'})-[r:ENTITY_RELATION]->" +
        "(b:Entity {entity_id: 'Acme'}) RETURN count(r) AS count",
    );
    expect(Number(sharedRelations[0].count)).toBe(1);

    const source = await rows<{ payload: string }>(
      output,
      "MATCH (s:ArticleSource {title: 'CVE-2025-1000'}) RETURN s.payload AS payload",
    );
    expect(JSON.parse(source[0].payload)).toEqual(
      JSON.parse(readFileSync(BASE_SOURCE, 'utf8').split('\n')[0]),
    );

    const vectorRows = await rows<{ id: string }>(
      output,
      "CALL QUERY_VECTOR_INDEX('Section', 'embedding_idx', [1.0, 0.0, " +
        `${new Array(766).fill('0.0').join(', ')}], 10) RETURN node.id AS id`,
    );
    expect(new Set(vectorRows.map((row) => row.id)).size).toBe(3);

    const validation = await validateKnowledgePack(output);
    expect(validation.valid).toBe(true);
    expect(validation.metadata.provenance).toMatchObject({
      corpus: {
        name: 'cvelistV5',
        commit: CORPUS_PROVENANCE.corpusCommit,
        date: '2026-07-03',
        tag: 'cve_2026-07-03_0000Z',
      },
    });
    expect(validation.counts).toMatchObject({
      articles: 3,
      entities: entities.length,
      relationSupport: 9,
    });

    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      packId: 'cve-fixture',
      version: '2.0.0',
      buildId: result.buildId,
      lineage: {
        base: { packId: 'cve-fixture', version: '1.0.0' },
        delta: { deltaId: result.deltaId },
      },
      update: { added: 1, modified: 1, unchanged: 1 },
      provenance: {
        corpus: {
          name: 'cvelistV5',
          commit: CORPUS_PROVENANCE.corpusCommit,
          date: '2026-07-03',
          tag: 'cve_2026-07-03_0000Z',
        },
      },
    });
    expect(manifest.files).toEqual([
      {
        path: 'pack.db',
        size: statSync(join(output, 'pack.db')).size,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(manifest.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(output).sort()).toEqual(['manifest.json', 'pack.db']);

    const manifestPath = join(output, 'manifest.json');
    const originalManifest = readFileSync(manifestPath, 'utf8');
    const incorrect = JSON.parse(originalManifest);
    incorrect.graph_stats.sections += 1;
    writeFileSync(manifestPath, `${JSON.stringify(incorrect, null, 2)}\n`);
    await expect(validateKnowledgePack(output)).rejects.toThrow(/manifest projection/i);
    writeFileSync(manifestPath, originalManifest);

    const incorrectUpdate = JSON.parse(originalManifest);
    incorrectUpdate.update.added += 1;
    writeFileSync(manifestPath, `${JSON.stringify(incorrectUpdate, null, 2)}\n`);
    await expect(validateKnowledgePack(output)).rejects.toThrow(/manifest projection/i);
    writeFileSync(manifestPath, originalManifest);

    const forgedClassification = JSON.parse(originalManifest);
    const modifiedRecord = forgedClassification.update.records.find(
      (record: { classification: string }) => record.classification === 'modified',
    );
    modifiedRecord.basePayloadSha256 = modifiedRecord.resultPayloadSha256;
    modifiedRecord.classification = 'unchanged';
    forgedClassification.update.modified -= 1;
    forgedClassification.update.unchanged += 1;
    writeFileSync(manifestPath, `${JSON.stringify(forgedClassification, null, 2)}\n`);
    await expect(validateKnowledgePack(output)).rejects.toThrow(/manifest projection/i);
    writeFileSync(manifestPath, originalManifest);
  });

  it('treats an exact existing build as a validated no-op and rejects collisions', async () => {
    mkdirSync(`${output}.work`);
    await expect(
      updateKnowledgePack({
        base,
        delta: DELTA,
        output,
        version: '2.0.0',
        embedder,
      }),
    ).rejects.toThrow(/--resume/i);
    rmSync(`${output}.work`, { recursive: true, force: true });

    const completedDigest = treeDigest(output);
    const repeated = await updateKnowledgePack({
      base,
      delta: DELTA,
      output,
      version: '2.0.0',
      embedder,
    });
    expect(repeated.noop).toBe(true);
    expect(treeDigest(output)).toBe(completedDigest);

    const conflicting = join(temp, 'collision');
    writeFileSync(conflicting, 'occupied');
    await expect(
      updateKnowledgePack({
        base,
        delta: DELTA,
        output: conflicting,
        version: '2.0.0',
        embedder,
      }),
    ).rejects.toThrow(/already exists|collision/i);
    expect(readFileSync(conflicting, 'utf8')).toBe('occupied');
  });

  it.each([
    ['duplicate stable keys', join(FIXTURES, 'duplicate.ndjson'), /duplicate.*CVE-2025-1002/i],
    ['explicit deletes', join(FIXTURES, 'delete.ndjson'), /delete.*not supported/i],
  ])('rejects %s before publishing', async (_name, delta, expected) => {
    const rejectedOutput = join(temp, `rejected-${basename(delta)}`);
    await expect(
      updateKnowledgePack({
        base,
        delta,
        output: rejectedOutput,
        version: '3.0.0',
        embedder,
      }),
    ).rejects.toThrow(expected);
    expect(existsSync(rejectedOutput)).toBe(false);
    expect(treeDigest(base)).toBe(baseDigest);
  });

  it.each([
    [
      'REJECTED records',
      {
        cveMetadata: { cveId: 'CVE-2025-9000', state: 'REJECTED' },
        containers: { cna: { descriptions: [{ lang: 'en', value: 'rejected' }] } },
      },
      /REJECTED/i,
    ],
    [
      'key/CVE mismatches',
      {
        operation: 'upsert',
        key: 'CVE-2025-9001',
        payload: {
          cveMetadata: { cveId: 'CVE-2025-9002', state: 'PUBLISHED' },
          containers: { cna: { descriptions: [{ lang: 'en', value: 'mismatch' }] } },
        },
      },
      /key does not match/i,
    ],
    ['malformed records', { not: 'a CVE record' }, /valid CVE stable key/i],
    [
      'malformed CVE identifiers',
      {
        cveMetadata: { cveId: 'CVE-2025-1', state: 'PUBLISHED' },
        containers: { cna: { descriptions: [{ lang: 'en', value: 'invalid identifier' }] } },
      },
      /valid CVE stable key/i,
    ],
  ])('preflights and rejects %s before creating work', async (name, record, expected) => {
    const delta = join(temp, `${name.replace(/\W+/g, '-')}.ndjson`);
    const rejectedOutput = join(temp, `${name.replace(/\W+/g, '-')}-output`);
    writeFileSync(delta, `${JSON.stringify(record)}\n`);
    await expect(
      updateKnowledgePack({
        base,
        delta,
        output: rejectedOutput,
        version: '3.0.1',
        embedder,
      }),
    ).rejects.toThrow(expected);
    expect(existsSync(rejectedOutput)).toBe(false);
    expect(existsSync(`${rejectedOutput}.work`)).toBe(false);
    expect(treeDigest(base)).toBe(baseDigest);
  });

  it('preserves omitted base articles without counting them as unchanged', async () => {
    const modifiedOnly = join(temp, 'modified-only.ndjson');
    const record = readFileSync(DELTA, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((value) => value.cveMetadata.cveId === 'CVE-2025-1001');
    writeFileSync(modifiedOnly, `${JSON.stringify(record)}\n`);
    const omittedOutput = join(temp, 'omitted-output');

    const result = await updateKnowledgePack({
      base,
      delta: modifiedOnly,
      output: omittedOutput,
      version: '3.0.2',
      embedder,
    });

    expect(result).toMatchObject({ added: 0, modified: 1, unchanged: 0 });
    expect(
      await rows(
        omittedOutput,
        "MATCH (a:Article {title: 'CVE-2025-1000'}) RETURN a.title AS title",
      ),
    ).toHaveLength(1);
  });

  it('never replaces a destination created at the publication boundary', async () => {
    const racedOutput = join(temp, 'raced-output');
    const marker = join(racedOutput, 'owner.txt');
    await expect(
      updateKnowledgePack({
        base,
        delta: DELTA,
        output: racedOutput,
        version: '3.0.3',
        embedder,
        onCheckpoint(checkpoint) {
          if (checkpoint.phase === 'delta-applied' && !existsSync(racedOutput)) {
            mkdirSync(racedOutput);
            writeFileSync(marker, 'other publisher');
          }
        },
      }),
    ).rejects.toThrow();
    expect(readFileSync(marker, 'utf8')).toBe('other publisher');
    expect(treeDigest(base)).toBe(baseDigest);
  });

  it('rejects forged authoritative pack metadata even with a matching projection', async () => {
    const corrupted = join(temp, 'corrupted-pack-metadata');
    await buildCvePack({
      source: BASE_SOURCE,
      output: corrupted,
      packId: 'cve-fixture',
      version: '1.0.4',
      embedder,
      ...CORPUS_PROVENANCE,
    });
    const database = new Database(join(corrupted, 'pack.db'));
    const connection = database.connect();
    try {
      await connection.run(
        `MATCH (m:PackMetadata {id: 'pack'}) SET m.version = '9.0.0', m.build_id = '${'0'.repeat(64)}'`,
      );
      await connection.run('CHECKPOINT');
    } finally {
      connection.close();
      database.close();
    }
    const manifestPath = join(corrupted, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const payload = {
      path: 'pack.db',
      size: statSync(join(corrupted, 'pack.db')).size,
      sha256: createHash('sha256')
        .update(readFileSync(join(corrupted, 'pack.db')))
        .digest('hex'),
    };
    manifest.version = '9.0.0';
    manifest.buildId = '0'.repeat(64);
    manifest.files = [payload];
    manifest.contentDigest = createHash('sha256')
      .update(canonical([payload]))
      .digest('hex');
    manifest.graph_stats.payload_bytes = payload.size;
    manifest.graph_stats.size_mb = Math.round((payload.size / (1024 * 1024)) * 100) / 100;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(validateKnowledgePack(corrupted)).rejects.toThrow(/database build ID/i);
  });

  it('rejects overlapping base, output, and work paths', async () => {
    const nestedOutput = join(temp, 'nested', 'output');
    await expect(
      updateKnowledgePack({
        base,
        delta: DELTA,
        output: nestedOutput,
        version: '3.0.0',
        workDir: temp,
        embedder,
      }),
    ).rejects.toThrow(/must not overlap/i);
    expect(existsSync(nestedOutput)).toBe(false);
    expect(treeDigest(base)).toBe(baseDigest);
  });

  it.each(['2026..07', 'foo'])(
    'rejects malformed or undiscoverable target version %s before creating work',
    async (version) => {
      const invalidOutput = join(temp, `invalid-version-${version.replace(/\W+/g, '-')}`);
      await expect(
        updateKnowledgePack({
          base,
          delta: DELTA,
          output: invalidOutput,
          version,
          embedder,
        }),
      ).rejects.toThrow(/invalid target version/i);
      expect(existsSync(`${invalidOutput}.work`)).toBe(false);
    },
  );

  it('rejects entity metadata not emitted by the retained source payloads', async () => {
    const corrupted = join(temp, 'corrupted-entity-pack');
    await buildCvePack({
      source: BASE_SOURCE,
      output: corrupted,
      packId: 'cve-fixture',
      version: '1.0.1',
      embedder,
      ...CORPUS_PROVENANCE,
    });
    const database = new Database(join(corrupted, 'pack.db'));
    const connection = database.connect();
    try {
      await connection.run(
        "MATCH (e:Entity {entity_id: 'Acme'}) SET e.description = 'tampered metadata'",
      );
      await connection.run('CHECKPOINT');
    } finally {
      connection.close();
      database.close();
    }
    const manifestPath = join(corrupted, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const payload = {
      path: 'pack.db',
      size: statSync(join(corrupted, 'pack.db')).size,
      sha256: createHash('sha256')
        .update(readFileSync(join(corrupted, 'pack.db')))
        .digest('hex'),
    };
    manifest.files = [payload];
    manifest.contentDigest = createHash('sha256')
      .update(canonical([payload]))
      .digest('hex');
    manifest.graph_stats.payload_bytes = payload.size;
    manifest.graph_stats.size_mb = Math.round((payload.size / (1024 * 1024)) * 100) / 100;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(validateKnowledgePack(corrupted)).rejects.toThrow(/entity data.*extractor/i);
  });

  it('normalizes delta transport whitespace without treating the CVE as changed', async () => {
    const whitespaceDelta = join(temp, 'whitespace-delta.ndjson');
    const unchangedPayload = readFileSync(BASE_SOURCE, 'utf8').split('\n')[0];
    writeFileSync(whitespaceDelta, `  ${unchangedPayload}\t\n`);
    const whitespaceOutput = join(temp, 'whitespace-output');

    const result = await updateKnowledgePack({
      base,
      delta: whitespaceDelta,
      output: whitespaceOutput,
      version: '1.1.0',
      embedder,
    });

    expect(result).toMatchObject({ added: 0, modified: 0, unchanged: 1 });
    const source = await rows<{ payload: string }>(
      whitespaceOutput,
      "MATCH (s:ArticleSource {title: 'CVE-2025-1000'}) RETURN s.payload AS payload",
    );
    expect(JSON.parse(source[0].payload)).toEqual(JSON.parse(unchangedPayload));
    expect(await rows(whitespaceOutput, 'MATCH (a:Article) RETURN a.title AS title')).toHaveLength(
      2,
    );
  });

  it('resumes from a durable graph-copy checkpoint', async () => {
    const checkpointOutput = join(temp, 'graph-checkpoint-output');
    const checkpointWork = `${checkpointOutput}.work`;
    let interrupted = false;
    await expect(
      updateKnowledgePack({
        base,
        delta: DELTA,
        output: checkpointOutput,
        version: '3.1.0',
        embedder,
        onCheckpoint(checkpoint) {
          if (!interrupted && checkpoint.phase === 'prepared') {
            interrupted = true;
            throw new Error('simulated graph-copy interruption');
          }
        },
      }),
    ).rejects.toThrow('simulated graph-copy interruption');

    const state = JSON.parse(readFileSync(join(checkpointWork, 'update-state.json'), 'utf8'));
    expect(state.phase).toBe('prepared');
    expect(state.records.every((record: { processed: boolean }) => record.processed)).toBe(true);
    expect(existsSync(join(checkpointWork, 'staging', 'pack.db'))).toBe(true);
    expect(existsSync(checkpointOutput)).toBe(false);
    const provenanceHash = state.baseProvenanceSha256;
    state.baseProvenanceSha256 = 'f'.repeat(64);
    writeFileSync(join(checkpointWork, 'update-state.json'), `${JSON.stringify(state, null, 2)}\n`);
    await expect(updateKnowledgePack({ resume: checkpointWork, embedder })).rejects.toThrow(
      /corpus provenance changed/i,
    );
    state.baseProvenanceSha256 = provenanceHash;
    state.records[0].processed = false;
    writeFileSync(join(checkpointWork, 'update-state.json'), `${JSON.stringify(state, null, 2)}\n`);

    await expect(updateKnowledgePack({ resume: checkpointWork, embedder })).resolves.toMatchObject({
      version: '3.1.0',
      noop: false,
    });
    expect(await validateKnowledgePack(checkpointOutput)).toMatchObject({
      valid: true,
      counts: { articles: 3 },
    });
  });

  it('keeps interrupted-build checkpoints separate from incremental update work', async () => {
    const resumedOutput = join(temp, 'resumed');
    const resumeDelta = join(temp, 'resume-delta.ndjson');
    const deltaBytes = readFileSync(DELTA);
    writeFileSync(resumeDelta, deltaBytes);
    const workDir = `${resumedOutput}.work`;
    const uninterrupted = await updateKnowledgePack({
      base,
      delta: resumeDelta,
      output: resumedOutput,
      version: '4.0.0',
      embedder,
    });
    const uninterruptedDigest = await logicalPackDigest(resumedOutput);
    rmSync(resumedOutput, { recursive: true, force: true });
    let interrupted = false;
    await expect(
      updateKnowledgePack({
        base,
        delta: resumeDelta,
        output: resumedOutput,
        version: '4.0.0',
        embedder,
        onCheckpoint(checkpoint) {
          if (!interrupted && checkpoint.phase === 'delta-applied') {
            interrupted = true;
            throw new Error('simulated interruption');
          }
        },
      }),
    ).rejects.toThrow('simulated interruption');
    expect(existsSync(resumedOutput)).toBe(false);
    expect(existsSync(join(workDir, 'update-state.json'))).toBe(true);
    const stagedPayload = readFileSync(join(workDir, 'staging', 'pack.db'));
    const stagedManifest = readFileSync(join(workDir, 'staging', 'manifest.json'));
    expect(existsSync(`${join(resumedOutput, 'pack.db')}.build-checkpoint.json`)).toBe(false);

    await expect(
      updateKnowledgePack({
        resume: workDir,
        embedder: { ...embedder, modelId: 'different-test-embedder' },
      }),
    ).rejects.toThrow(/embedding model changed/i);

    await expect(
      updateKnowledgePack({
        base,
        delta: resumeDelta,
        output: resumedOutput,
        version: '4.0.0',
        embedder,
      }),
    ).rejects.toThrow(/--resume/i);

    writeFileSync(resumeDelta, Buffer.concat([deltaBytes, Buffer.from('\n')]));
    await expect(updateKnowledgePack({ resume: workDir, embedder })).rejects.toThrow(
      /delta input changed/i,
    );
    writeFileSync(resumeDelta, deltaBytes);
    const resumed = await updateKnowledgePack({ resume: workDir, embedder });
    expect(resumed.version).toBe('4.0.0');
    expect(await validateKnowledgePack(resumedOutput)).toMatchObject({ valid: true });
    expect(resumed.buildId).toBe(uninterrupted.buildId);
    expect(await logicalPackDigest(resumedOutput)).toBe(uninterruptedDigest);
    expect(Buffer.compare(readFileSync(join(resumedOutput, 'pack.db')), stagedPayload)).toBe(0);
    expect(Buffer.compare(readFileSync(join(resumedOutput, 'manifest.json')), stagedManifest)).toBe(
      0,
    );
  });

  it('durably resumes multiple batches with byte-identical staged publication', async () => {
    const largeDelta = join(temp, 'large-delta.ndjson');
    const records = Array.from({ length: 257 }, (_, index) => ({
      cveMetadata: {
        cveId: `CVE-2026-${10000 + index}`,
        state: 'PUBLISHED',
        datePublished: '2026-07-03T00:00:00.000Z',
      },
      containers: {
        cna: {
          title: `Synthetic CVE ${index}`,
          descriptions: [{ lang: 'en', value: `Deterministic batch record ${index}.` }],
          affected: [],
        },
      },
    }));
    writeFileSync(largeDelta, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const largeOutput = join(temp, 'large-output');
    const workDir = `${largeOutput}.work`;

    await updateKnowledgePack({
      base,
      delta: largeDelta,
      output: largeOutput,
      version: '5.0.0',
      embedder,
    });
    const expectedDigest = await logicalPackDigest(largeOutput);
    const sectionCount = await rows<{ count: number | bigint }>(
      largeOutput,
      'MATCH (s:Section) RETURN count(s) AS count',
    );
    const chunkCount = await rows<{ count: number | bigint }>(
      largeOutput,
      'MATCH (c:Chunk) RETURN count(c) AS count',
    );
    expect(Number(sectionCount[0].count)).toBeGreaterThan(256);
    expect(Number(chunkCount[0].count)).toBeGreaterThan(256);
    rmSync(largeOutput, { recursive: true });

    let checkpoints = 0;
    await expect(
      updateKnowledgePack({
        base,
        delta: largeDelta,
        output: largeOutput,
        version: '5.0.0',
        embedder,
        onCheckpoint(checkpoint) {
          if (checkpoint.phase === 'prepared' && checkpoints++ === 0) {
            throw new Error('simulated multi-batch interruption');
          }
        },
      }),
    ).rejects.toThrow('simulated multi-batch interruption');
    const interruptedState = JSON.parse(
      readFileSync(join(workDir, 'update-state.json'), 'utf8'),
    ) as { records: Array<{ processed: boolean }> };
    const processed = interruptedState.records.filter((record) => record.processed).length;
    expect(processed).toBeGreaterThan(0);
    expect(processed).toBeLessThan(257);
    expect(existsSync(largeOutput)).toBe(false);

    await expect(
      updateKnowledgePack({
        resume: workDir,
        embedder,
        onCheckpoint(checkpoint) {
          if (checkpoint.phase === 'delta-applied')
            throw new Error('simulated publication interruption');
        },
      }),
    ).rejects.toThrow('simulated publication interruption');
    const stagedPayload = readFileSync(join(workDir, 'staging', 'pack.db'));
    const stagedManifest = readFileSync(join(workDir, 'staging', 'manifest.json'));

    await updateKnowledgePack({ resume: workDir, embedder });
    expect(await logicalPackDigest(largeOutput)).toBe(expectedDigest);
    expect(Buffer.compare(readFileSync(join(largeOutput, 'pack.db')), stagedPayload)).toBe(0);
    expect(Buffer.compare(readFileSync(join(largeOutput, 'manifest.json')), stagedManifest)).toBe(
      0,
    );
    expect(existsSync(workDir)).toBe(false);
  }, 180_000);
});
