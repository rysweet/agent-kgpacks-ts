// packages/query/test/reranker.test.ts
//
// Deterministic contract for the graph reranker (`graphRerank`). It re-orders a
// candidate list by LINKS_TO graph proximity: the top-`seedK` candidates are
// traversal seeds, and every candidate that is a 1-hop neighbour of a seed AND
// already in the list gains a decayed boost
//   boost = alpha * seedScore / (1 + hopDistance)
// before a descending re-sort with a stable (original-rank) tie-break. No model,
// no network — a `RecordingConnection` answers the LINKS_TO traversal.
//
// TDD: FAILS until `graphRerank` is implemented and exported from src/index.ts.

import { describe, expect, it } from 'vitest';

import { graphRerank } from '../src/index.js';
import type { RetrieverResult } from '../src/index.js';
import { RecordingConnection, type Responder } from './helpers.js';

/** A LINKS_TO responder keyed on the bound seed id (`seedId -> neighbourIds`). */
function linksResponder(graph: Record<string, string[]>): Responder {
  return (cypher, params) => {
    if (!cypher.includes('LINKS_TO')) {
      return [];
    }
    const seedId = String(params?.id);
    return (graph[seedId] ?? []).map((id) => ({ id }));
  };
}

const c = (id: string, score: number, content = `content-${id}`): RetrieverResult => ({
  id,
  score,
  content,
});

describe('graphRerank — neighbour-boost math (default options)', () => {
  it('boosts a top-seed neighbour by alpha*seedScore/(1+hop) and re-sorts', async () => {
    const conn = new RecordingConnection(linksResponder({ A: ['C'] }));
    const candidates = [c('A', 0.9), c('B', 0.5), c('C', 0.4), c('D', 0.3)];

    // Defaults: alpha=0.5, seedK=5, maxHops=1 -> boost(C) = 0.5*0.9/2 = 0.225.
    const out = await graphRerank(conn.asConnection(), candidates);

    expect(out.map((r) => r.id)).toEqual(['A', 'C', 'B', 'D']);
    const byId = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(byId.C.score).toBeCloseTo(0.625, 10);
    expect(byId.A.score).toBeCloseTo(0.9, 10);
    expect(byId.B.score).toBeCloseTo(0.5, 10);
    expect(byId.D.score).toBeCloseTo(0.3, 10);
  });

  it('preserves each candidate’s content through the re-rank', async () => {
    const conn = new RecordingConnection(linksResponder({ A: ['C'] }));
    const candidates = [c('A', 0.9, 'alpha'), c('B', 0.5, 'bravo'), c('C', 0.4, 'charlie')];

    const out = await graphRerank(conn.asConnection(), candidates);

    expect(Object.fromEntries(out.map((r) => [r.id, r.content]))).toEqual({
      A: 'alpha',
      B: 'bravo',
      C: 'charlie',
    });
  });

  it('accumulates boosts when several seeds link to the same neighbour', async () => {
    const conn = new RecordingConnection(linksResponder({ A: ['C'], B: ['C'] }));
    const candidates = [c('A', 0.8), c('B', 0.6), c('C', 0.2)];

    // boost(C) = 0.5*0.8/2 + 0.5*0.6/2 = 0.2 + 0.15 = 0.35 -> 0.55
    const out = await graphRerank(conn.asConnection(), candidates);

    expect(out.map((r) => r.id)).toEqual(['A', 'B', 'C']);
    expect(out.find((r) => r.id === 'C')?.score).toBeCloseTo(0.55, 10);
  });
});

describe('graphRerank — only boosts existing candidates', () => {
  it('ignores neighbours that are not already in the candidate set', async () => {
    const conn = new RecordingConnection(linksResponder({ A: ['Z'] }));
    const candidates = [c('A', 0.9), c('B', 0.5)];

    const out = await graphRerank(conn.asConnection(), candidates);

    // Z must never be introduced; A/B unchanged.
    expect(out.map((r) => r.id)).toEqual(['A', 'B']);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.id === 'A')?.score).toBeCloseTo(0.9, 10);
    expect(out.find((r) => r.id === 'B')?.score).toBeCloseTo(0.5, 10);
  });

  it('returns the list unchanged when the graph has no in-set edges', async () => {
    const conn = new RecordingConnection(linksResponder({}));
    const candidates = [c('A', 0.9), c('B', 0.5), c('C', 0.4)];

    const out = await graphRerank(conn.asConnection(), candidates);

    expect(out).toEqual(candidates);
  });
});

describe('graphRerank — option effects', () => {
  it('seedK limits which candidates act as traversal seeds', async () => {
    const candidates = [c('A', 0.9), c('B', 0.5), c('C', 0.4)];
    const graph = { C: ['B'] }; // only the lowest-ranked candidate has an edge

    const connAll = new RecordingConnection(linksResponder(graph));
    const withAllSeeds = await graphRerank(connAll.asConnection(), candidates, { seedK: 5 });
    // C is a seed -> boost(B) = 0.5*0.4/2 = 0.1 -> 0.6
    expect(withAllSeeds.find((r) => r.id === 'B')?.score).toBeCloseTo(0.6, 10);

    const connTop1 = new RecordingConnection(linksResponder(graph));
    const withOneSeed = await graphRerank(connTop1.asConnection(), candidates, { seedK: 1 });
    // Only A is a seed; A has no edges -> B untouched.
    expect(withOneSeed.find((r) => r.id === 'B')?.score).toBeCloseTo(0.5, 10);
  });

  it('alpha scales the boost magnitude', async () => {
    const candidates = [c('A', 0.8), c('B', 0.2)];
    const graph = { A: ['B'] };

    const half = await graphRerank(
      new RecordingConnection(linksResponder(graph)).asConnection(),
      candidates,
      { alpha: 0.5 },
    );
    // 0.5*0.8/2 = 0.2 -> 0.4
    expect(half.find((r) => r.id === 'B')?.score).toBeCloseTo(0.4, 10);

    const full = await graphRerank(
      new RecordingConnection(linksResponder(graph)).asConnection(),
      candidates,
      { alpha: 1 },
    );
    // 1*0.8/2 = 0.4 -> 0.6
    expect(full.find((r) => r.id === 'B')?.score).toBeCloseTo(0.6, 10);
  });
});

describe('graphRerank — deterministic tie-break', () => {
  it('keeps original order for equal incoming scores (stable, not id-sorted)', async () => {
    const conn = new RecordingConnection(linksResponder({}));
    // Provided B-before-A; equal scores must NOT be re-sorted to id order.
    const candidates = [c('B', 0.5), c('A', 0.5)];

    const out = await graphRerank(conn.asConnection(), candidates);

    expect(out.map((r) => r.id)).toEqual(['B', 'A']);
  });

  it('breaks a boost-induced tie by original rank', async () => {
    const conn = new RecordingConnection(linksResponder({ X: ['Y'] }));
    const candidates = [c('X', 0.5), c('Y', 0.25)];

    // alpha=1 -> boost(Y) = 1*0.5/2 = 0.25 -> Y=0.5, equal to X.
    const out = await graphRerank(conn.asConnection(), candidates, { alpha: 1 });

    expect(out.map((r) => r.id)).toEqual(['X', 'Y']);
    expect(out[0].score).toBeCloseTo(0.5, 10);
    expect(out[1].score).toBeCloseTo(0.5, 10);
  });
});
