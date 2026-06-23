// parity/diff/test/parity.test.ts
//
// Behavioral spec for @kgpacks/parity, the stage-localizing parity diff harness.
//
// The committed sample-golden.json is the oracle. Each test starts from a
// pipeline output that PERFECTLY reproduces the golden fixture, then perturbs a
// single stage (or several) to assert that compareStages localizes the
// divergence to the right stage with the right `firstDivergedStage`.

import { describe, expect, it } from 'vitest';

import { assertGoldenFixture, compareStages, cosineSimilarity, loadFixture } from '../src/index.js';
import type { GoldenFixture, PipelineOutput } from '../src/index.js';

const fixtureUrl = new URL('./fixtures/sample-golden.json', import.meta.url);

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
