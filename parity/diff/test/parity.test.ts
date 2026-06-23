// parity/diff/test/parity.test.ts
//
// Behavioral spec for @kgpacks/parity, the stage-localizing parity diff harness.
//
// The committed sample-golden.json is the oracle. Each test starts from a
// pipeline output that PERFECTLY reproduces the golden fixture, then perturbs a
// single stage (or several) to assert that compareStages localizes the
// divergence to the right stage with the right `firstDivergedStage`.

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  STAGE_ORDER,
  assertGoldenFixture,
  compareStages,
  cosineSimilarity,
  loadFixture,
} from '../src/index.js';
import type { GoldenFixture, PipelineOutput } from '../src/index.js';

const fixtureUrl = new URL('./fixtures/sample-golden.json', import.meta.url);

// A structurally valid parsed fixture (plain object, not yet asserted). Tests
// clone this and corrupt ONE field to exercise each validation branch in
// assertGoldenFixture independently.
function validRaw(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provenance: {},
    case: { id: 'c', query: 'q', config: { topK: 1, cosineThreshold: 0.999, seed: 1 } },
    stages: {
      queryEmbedding: { dim: 2, vector: [0.1, 0.2] },
      retrievedIds: ['n1'],
      rerankedIds: ['n1'],
      finalAnswer: { citations: ['n1'], topK: ['n1'], seed: 1, text: 't' },
    },
  };
}

function golden(): GoldenFixture {
  return loadFixture(fixtureUrl);
}

// A pipeline output that exactly reproduces the golden fixture (all stages match).
function matchingOutput(g: GoldenFixture): PipelineOutput {
  return {
    queryEmbedding: [...g.stages.queryEmbedding.vector],
    retrievedIds: [...g.stages.retrievedIds],
    rerankedIds: [...g.stages.rerankedIds],
    finalAnswer: {
      citations: [...g.stages.finalAnswer.citations],
      topK: [...g.stages.finalAnswer.topK],
      seed: g.stages.finalAnswer.seed,
      text: g.stages.finalAnswer.text,
    },
  };
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors and is scale-invariant', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
  });

  it('returns 0 for orthogonal vectors and for a zero vector', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dimension mismatch/);
  });
});

describe('loadFixture / assertGoldenFixture', () => {
  it('round-trips the committed sample fixture', () => {
    const g = golden();
    expect(g.schemaVersion).toBe(1);
    expect(g.case.id).toBe('sample-1');
    expect(g.stages.queryEmbedding.vector).toHaveLength(g.stages.queryEmbedding.dim);
    expect(g.case.config.cosineThreshold).toBe(0.999);
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(() => assertGoldenFixture({ schemaVersion: 2 })).toThrow(/schemaVersion/);
  });

  it('rejects a non-object value', () => {
    expect(() => assertGoldenFixture(null)).toThrow(/golden fixture/);
  });

  it('loads from a plain string path as well as a URL', () => {
    const g = loadFixture(fileURLToPath(fixtureUrl));
    expect(g.case.id).toBe('sample-1');
  });
});

describe('assertGoldenFixture — field validation', () => {
  it('rejects a missing "stages" object', () => {
    const raw = validRaw();
    delete raw.stages;
    expect(() => assertGoldenFixture(raw)).toThrow(/stages/);
  });

  it('rejects a non-numeric query embedding vector', () => {
    const raw = validRaw();
    (raw.stages as Record<string, unknown>).queryEmbedding = { dim: 2, vector: ['a', 'b'] };
    expect(() => assertGoldenFixture(raw)).toThrow(/queryEmbedding\.vector/);
  });

  it('rejects retrievedIds that are not a string[]', () => {
    const raw = validRaw();
    (raw.stages as Record<string, unknown>).retrievedIds = [1, 2, 3];
    expect(() => assertGoldenFixture(raw)).toThrow(/retrievedIds/);
  });

  it('rejects rerankedIds that are not a string[]', () => {
    const raw = validRaw();
    (raw.stages as Record<string, unknown>).rerankedIds = [{}];
    expect(() => assertGoldenFixture(raw)).toThrow(/rerankedIds/);
  });

  it('rejects a finalAnswer missing required fields', () => {
    const raw = validRaw();
    (raw.stages as Record<string, unknown>).finalAnswer = { citations: ['n1'], topK: ['n1'] };
    expect(() => assertGoldenFixture(raw)).toThrow(/finalAnswer/);
  });

  it('rejects a missing case.config', () => {
    const raw = validRaw();
    raw.case = { id: 'c', query: 'q' };
    expect(() => assertGoldenFixture(raw)).toThrow(/case\.config/);
  });

  it('rejects a non-numeric cosineThreshold', () => {
    const raw = validRaw();
    (raw.case as { config: Record<string, unknown> }).config.cosineThreshold = 'tight';
    expect(() => assertGoldenFixture(raw)).toThrow(/cosineThreshold/);
  });
});

describe('STAGE_ORDER', () => {
  it('is the canonical four-stage pipeline order', () => {
    expect([...STAGE_ORDER]).toEqual([
      'query-embedding',
      'retrieved-ids',
      'reranked-ids',
      'final-answer',
    ]);
  });
});

describe('compareStages — all stages match', () => {
  it('reports pass:true with no diverged stage', () => {
    const g = golden();
    const report = compareStages(matchingOutput(g), g);

    expect(report.pass).toBe(true);
    expect(report.firstDivergedStage).toBeNull();
    expect(report.stages['query-embedding'].status).toBe('match');
    expect(report.stages['retrieved-ids'].status).toBe('match');
    expect(report.stages['reranked-ids'].status).toBe('match');
    expect(report.stages['final-answer'].status).toBe('match');
  });
});

describe('compareStages — query-embedding stage', () => {
  it('matches an embedding within the cosine tolerance (perturbed but >= 0.999)', () => {
    const g = golden();
    const out = matchingOutput(g);
    // Small off-axis perturbation: cosine stays >= 0.999 but is not exactly 1.
    out.queryEmbedding[0] += 0.01;

    const sim = cosineSimilarity(out.queryEmbedding, g.stages.queryEmbedding.vector);
    expect(sim).toBeGreaterThanOrEqual(0.999);
    expect(sim).toBeLessThan(1);

    const report = compareStages(out, g);
    expect(report.pass).toBe(true);
    expect(report.stages['query-embedding'].status).toBe('match');
  });

  it('diverges when cosine drops below the threshold', () => {
    const g = golden();
    const out = matchingOutput(g);
    // Reverse the vector: cosine ~0.59, well below 0.999.
    out.queryEmbedding = [...g.stages.queryEmbedding.vector].reverse();

    const report = compareStages(out, g);
    expect(report.pass).toBe(false);
    expect(report.firstDivergedStage).toBe('query-embedding');
    expect(report.stages['query-embedding'].status).toBe('diverged');
  });

  it('diverges on dimension mismatch without throwing', () => {
    const g = golden();
    const out = matchingOutput(g);
    out.queryEmbedding = [0.1, 0.2, 0.3, 0.4];

    const report = compareStages(out, g);
    expect(report.firstDivergedStage).toBe('query-embedding');
    expect(report.stages['query-embedding'].detail).toMatch(/dimension mismatch/);
  });

  it('honours a cosineThreshold override that tightens the gate', () => {
    const g = golden();
    const out = matchingOutput(g);
    out.queryEmbedding[0] += 0.01; // cosine ~0.99997

    expect(compareStages(out, g).stages['query-embedding'].status).toBe('match');
    // Demand effectively-exact equality -> the same perturbation now diverges.
    const strict = compareStages(out, g, { cosineThreshold: 0.999999 });
    expect(strict.stages['query-embedding'].status).toBe('diverged');
  });

  it('honours a cosineThreshold override that loosens the gate', () => {
    const g = golden();
    const out = matchingOutput(g);
    // Perturb enough to drop below the fixture default (0.999) but stay high.
    out.queryEmbedding[0] += 0.3;

    const sim = cosineSimilarity(out.queryEmbedding, g.stages.queryEmbedding.vector);
    expect(sim).toBeLessThan(0.999);
    expect(sim).toBeGreaterThan(0.9);

    // Default fixture threshold -> diverged.
    expect(compareStages(out, g).stages['query-embedding'].status).toBe('diverged');
    // A looser override accepts it.
    const loose = compareStages(out, g, { cosineThreshold: 0.9 });
    expect(loose.stages['query-embedding'].status).toBe('match');
    expect(loose.pass).toBe(true);
  });
});

describe('compareStages — retrieval & reranking stages', () => {
  it('localizes a changed retrieved-ids set/order to retrieved-ids', () => {
    const g = golden();
    const out = matchingOutput(g);
    out.retrievedIds = ['n1', 'n2', 'n3', 'n4', 'nX'];

    const report = compareStages(out, g);
    expect(report.firstDivergedStage).toBe('retrieved-ids');
    expect(report.stages['retrieved-ids'].status).toBe('diverged');
    expect(report.stages['reranked-ids'].status).toBe('match');
  });

  it('treats reranked-ids as ordered (reordering diverges)', () => {
    const g = golden();
    const out = matchingOutput(g);
    out.rerankedIds = [...g.stages.rerankedIds].reverse();

    const report = compareStages(out, g);
    expect(report.firstDivergedStage).toBe('reranked-ids');
    expect(report.stages['retrieved-ids'].status).toBe('match');
    expect(report.stages['reranked-ids'].status).toBe('diverged');
  });
});

describe('compareStages — final-answer stage (structural)', () => {
  it('matches when citations are the same set in a different order', () => {
    const g = golden();
    const out = matchingOutput(g);
    out.finalAnswer.citations = [...g.stages.finalAnswer.citations].reverse();

    const report = compareStages(out, g);
    expect(report.pass).toBe(true);
    expect(report.stages['final-answer'].status).toBe('match');
  });

  it('ignores free-form answer text differences', () => {
    const g = golden();
    const out = matchingOutput(g);
    out.finalAnswer.text = 'A completely different wording of the same answer.';

    expect(compareStages(out, g).stages['final-answer'].status).toBe('match');
  });

  it('diverges when a citation is missing', () => {
    const g = golden();
    const out = matchingOutput(g);
    out.finalAnswer.citations = [g.stages.finalAnswer.citations[0]];

    const report = compareStages(out, g);
    expect(report.firstDivergedStage).toBe('final-answer');
    expect(report.stages['final-answer'].status).toBe('diverged');
    expect(report.stages['final-answer'].detail).toMatch(/citations/);
  });

  it('diverges when topK order changes (topK is ordered)', () => {
    const g = golden();
    const out = matchingOutput(g);
    out.finalAnswer.topK = [...g.stages.finalAnswer.topK].reverse();

    const report = compareStages(out, g);
    expect(report.firstDivergedStage).toBe('final-answer');
    expect(report.stages['final-answer'].status).toBe('diverged');
    expect(report.stages['final-answer'].detail).toMatch(/topK/);
  });

  it('diverges when the decoding seed changes', () => {
    const g = golden();
    const out = matchingOutput(g);
    out.finalAnswer.seed = g.stages.finalAnswer.seed + 1;

    expect(compareStages(out, g).stages['final-answer'].status).toBe('diverged');
  });
});

describe('compareStages — multi-stage divergence', () => {
  it('reports every diverged stage and picks the earliest as firstDivergedStage', () => {
    const g = golden();
    const out = matchingOutput(g);
    // Break BOTH retrieved-ids and final-answer.
    out.retrievedIds = ['x1', 'x2', 'x3', 'x4', 'x5'];
    out.finalAnswer.citations = ['nope'];

    const report = compareStages(out, g);
    expect(report.pass).toBe(false);
    // Earliest in canonical stage order wins.
    expect(report.firstDivergedStage).toBe('retrieved-ids');
    expect(report.stages['retrieved-ids'].status).toBe('diverged');
    expect(report.stages['final-answer'].status).toBe('diverged');
    // Untouched stages still report match -> the report localizes precisely.
    expect(report.stages['query-embedding'].status).toBe('match');
    expect(report.stages['reranked-ids'].status).toBe('match');
  });
});
