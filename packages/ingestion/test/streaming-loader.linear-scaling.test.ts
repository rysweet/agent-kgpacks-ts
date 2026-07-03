// packages/ingestion/test/streaming-loader.linear-scaling.test.ts
//
// GUARD (green today; locks a property against regression). The streaming loader's
// edge creation must stay ~linear in the number of records — protecting against a
// regression to the O(N²) COMMA two-pattern `MATCH` that PR #69 replaced with
// PK-indexed single-`MATCH` `UNWIND`. Wall-clock timing is flaky in CI, so the
// guard is STRUCTURAL, not temporal (docs/ci-perf-guards.md):
//   1. statement-count linearity — loading 2N records issues at most a small
//      constant factor more statements than N records (not quadratically more);
//   2. no COMMA two-pattern `MATCH` — every edge-creation statement uses the
//      PK-indexed shape, never `MATCH (a:Article {…}), (e:Entity {…})`.

import { describe, expect, it } from 'vitest';

import { Database, type Connection } from '@kgpacks/db';

import { createPackWriter } from '../src/streaming-loader.js';
import type { LoadableArticle } from '../src/loader.js';
import type { ArticleLink } from '../src/types.js';
import { oneHot } from './helpers.js';

// The regressing shape PR #69 removed: a single MATCH with two comma-separated node
// patterns over the growing node tables (hash-join → O(N²)).
const COMMA_TWO_PATTERN_MATCH_RE = /MATCH\s*\([^)]*\)\s*,\s*\(/;
// A conservative linear factor: 2N records may issue up to ~3× the statements of N
// (real ratio is ~2×). A quadratic per-record fan-out would blow well past this.
const LINEAR_FACTOR = 3;

/** One minimal record with a shared + a unique entity and a self-relation. */
function record(i: number): LoadableArticle {
  const title = `Doc-${i}`;
  const content = `${title} body about topic ${i}.`;
  return {
    article: {
      title,
      url: `https://example.test/${i}`,
      sections: [{ id: `${title}#0`, title, content, level: 0 }],
      links: [],
    },
    sectionEmbeddings: [oneHot(i)],
    chunks: [{ id: `${title}#0#0`, content, articleTitle: title, sectionIndex: 0, chunkIndex: 0 }],
    chunkEmbeddings: [oneHot(i)],
    extraction: {
      entities: [
        { name: 'Common', type: 'concept' },
        { name: `E${i}`, type: 'concept' },
      ],
      relationships: [{ source: `E${i}`, target: 'Common', relation: 'rel' }],
      keyFacts: [],
    },
  };
}

/** Wraps a real Connection, recording every Cypher statement it is asked to run. */
function recordingConnection(real: Connection): { conn: Connection; statements: string[] } {
  const statements: string[] = [];
  const conn = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'run') {
        return (cypher: string, params?: unknown) => {
          statements.push(cypher);
          return (target.run as (c: string, p?: unknown) => Promise<unknown[]>)(cypher, params);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Connection;
  return { conn, statements };
}

/** Loads `n` records (one addBatch each, like the streaming build) and returns the
 * full list of Cypher statements the loader issued. */
async function statementsForLoad(n: number): Promise<string[]> {
  const db = new Database();
  const real = db.connect();
  const { conn, statements } = recordingConnection(real);
  try {
    const writer = await createPackWriter(conn, { insertChunkSize: 1000 });
    const links: ArticleLink[] = [];
    for (let i = 0; i < n; i++) {
      await writer.addBatch([record(i)]);
      if (i > 0) links.push({ from: `Doc-${i - 1}`, to: `Doc-${i}`, linkType: 'wiki' });
    }
    await writer.finalize(links);
  } finally {
    real.close();
    db.close();
  }
  return statements;
}

describe('streaming loader — linear edge-creation guard', () => {
  it('issues a ~linear (not quadratic) statement count from N to 2N records', async () => {
    const N = 16;
    const s1 = await statementsForLoad(N);
    const s2 = await statementsForLoad(2 * N);

    expect(s1.length).toBeGreaterThan(0);
    // Grows with the corpus (batched, so ~2× — never collapses to a constant that
    // would hide a fan-out), but stays within a tight constant factor of linear.
    expect(s2.length).toBeGreaterThan(s1.length);
    expect(s2.length).toBeLessThanOrEqual(LINEAR_FACTOR * s1.length);
  });

  it('never uses the O(N²) COMMA two-pattern MATCH for any edge creation', async () => {
    const statements = await statementsForLoad(8);
    const edgeStatements = statements.filter((s) => s.includes('->') && s.includes('CREATE'));
    expect(edgeStatements.length).toBeGreaterThan(0); // HAS_SECTION/HAS_CHUNK/HAS_ENTITY/…
    for (const cypher of edgeStatements) {
      expect(cypher).not.toMatch(COMMA_TWO_PATTERN_MATCH_RE);
    }
  });
});
