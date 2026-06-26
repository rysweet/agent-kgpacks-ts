// packages/eval/test/baselines.test.ts
//
// Coverage for the two eval arms: with-pack runs retrieve+synthesize over the pack
// (forwarding opts); training-only synthesizes with an EMPTY context (no retrieval).

import { describe, expect, it } from 'vitest';

import { withPackArm, trainingOnlyArm } from '../src/index.js';
import { makeQuestion, zeroUsage } from './helpers.js';

describe('withPackArm', () => {
  it('is named "with-pack", calls retrieveAndSynthesize, and forwards opts', async () => {
    const calls: Array<{ question: string; opts: unknown }> = [];
    const retriever = {
      retrieve: async () => [],
      retrieveAndSynthesize: async (question: string, opts?: unknown) => {
        calls.push({ question, opts });
        return {
          results: [],
          synthesis: { answer: 'grounded answer', usage: zeroUsage(), citations: [] },
          exemplars: [],
        };
      },
    } as unknown as Parameters<typeof withPackArm>[0];

    const arm = withPackArm(retriever, { k: 7 });
    expect(arm.name).toBe('with-pack');

    const out = await arm.answer(makeQuestion({ question: 'What is HNSW?' }));
    expect(out.answer).toBe('grounded answer');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ question: 'What is HNSW?', opts: { k: 7 } });
  });
});

describe('trainingOnlyArm', () => {
  it('is named "training-only" and synthesizes EMPTY context in CLOSED-BOOK mode (no retrieval)', async () => {
    const calls: Array<{ question: string; context: unknown[]; closedBook?: boolean }> = [];
    const agent = {
      synthesizeAnswer: async (input: {
        question: string;
        context: unknown[];
        closedBook?: boolean;
      }) => {
        calls.push({
          question: input.question,
          context: input.context,
          closedBook: input.closedBook,
        });
        return { answer: 'from training only', usage: zeroUsage(), citations: [] };
      },
    } as unknown as Parameters<typeof trainingOnlyArm>[0];

    const arm = trainingOnlyArm(agent);
    expect(arm.name).toBe('training-only');

    const out = await arm.answer(makeQuestion({ question: 'What is HNSW?' }));
    expect(out.answer).toBe('from training only');
    expect(calls).toHaveLength(1);
    expect(calls[0].context).toEqual([]); // no pack context — the no-corpus baseline
    // Closed-book so the model answers from its OWN knowledge rather than refusing.
    expect(calls[0].closedBook).toBe(true);
  });
});
