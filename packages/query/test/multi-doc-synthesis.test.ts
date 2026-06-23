// packages/query/test/multi-doc-synthesis.test.ts
//
// Contract for `synthesizeFromResults` — the thin adapter from `RetrieverResult[]`
// to the agent's `SynthesisRequest`. It maps each result to a `ContextChunk`
// (`{ id, text: content }`), passes the full list when `multidoc` is true and
// only the top result when false, renders any `exemplars` into a demonstrations
// preamble on the question (WITHOUT adding them to `citedIds`), and returns the
// agent's `SynthesisResult` unchanged. No model calls are reimplemented — a mock
// `SynthesisAgent` records the request it received.
//
// TDD: FAILS until `synthesizeFromResults` is implemented and exported from
// src/index.ts.

import { describe, expect, it } from 'vitest';

import { synthesizeFromResults } from '../src/index.js';
import type { FewShotExample, RetrieverResult } from '../src/index.js';
import { fakeAgent, synthesisResult } from './helpers.js';

const RESULTS: RetrieverResult[] = [
  { id: '10', score: 0.9, content: 'Entanglement correlates measurement outcomes.' },
  { id: '7', score: 0.6, content: 'Bell inequalities bound local hidden variables.' },
  { id: '3', score: 0.4, content: 'Decoherence explains the classical limit.' },
];

describe('synthesizeFromResults — context mapping', () => {
  it('maps each result to a ContextChunk { id, text: content } (multidoc)', async () => {
    const agent = fakeAgent(() => synthesisResult('answer', ['10', '7']));

    await synthesizeFromResults(agent, 'what is entanglement?', RESULTS, { multidoc: true });

    expect(agent.requests).toHaveLength(1);
    expect(agent.requests[0].context).toEqual([
      { id: '10', text: 'Entanglement correlates measurement outcomes.' },
      { id: '7', text: 'Bell inequalities bound local hidden variables.' },
      { id: '3', text: 'Decoherence explains the classical limit.' },
    ]);
  });

  it('passes only the top result as context when multidoc is false', async () => {
    const agent = fakeAgent(() => synthesisResult('answer'));

    await synthesizeFromResults(agent, 'q', RESULTS, { multidoc: false });

    expect(agent.requests[0].context).toEqual([
      { id: '10', text: 'Entanglement correlates measurement outcomes.' },
    ]);
  });

  it('forwards a per-call timeout to the agent', async () => {
    const agent = fakeAgent(() => synthesisResult('answer'));

    await synthesizeFromResults(agent, 'q', RESULTS, { multidoc: true, timeoutMs: 4242 });

    expect(agent.requests[0].timeoutMs).toBe(4242);
  });
});

describe('synthesizeFromResults — exemplar preamble', () => {
  const exemplars: FewShotExample[] = [
    { id: 'ex:1', text: 'Q: What is HNSW? A: A navigable small-world graph index.' },
    { id: 'ex:2', text: 'Q: What is cosine? A: Dot product of unit vectors.' },
  ];

  it('renders exemplars into the question and keeps the original question', async () => {
    const agent = fakeAgent(() => synthesisResult('answer'));

    await synthesizeFromResults(agent, 'how does HNSW search work?', RESULTS, {
      multidoc: true,
      exemplars,
    });

    const { question } = agent.requests[0];
    expect(question).toContain('how does HNSW search work?');
    expect(question).toContain('A navigable small-world graph index.');
    expect(question).toContain('Dot product of unit vectors.');
  });

  it('does NOT add exemplars to citedIds (they only shape the prompt)', async () => {
    const agent = fakeAgent(() => synthesisResult('answer', ['10']));

    const out = await synthesizeFromResults(agent, 'q', RESULTS, {
      multidoc: true,
      exemplars,
    });

    expect(out.metadata.citedIds).toEqual(['10']);
    expect(out.metadata.citedIds).not.toContain('ex:1');
    expect(out.metadata.citedIds).not.toContain('ex:2');
  });
});

describe('synthesizeFromResults — passthrough', () => {
  it('returns the agent SynthesisResult unchanged', async () => {
    const canned = synthesisResult('the synthesized, cited answer', ['10', '7']);
    const agent = fakeAgent(() => canned);

    const out = await synthesizeFromResults(agent, 'q', RESULTS, { multidoc: true });

    expect(out).toEqual(canned);
  });
});
