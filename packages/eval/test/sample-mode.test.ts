// packages/eval/test/sample-mode.test.ts
//
// Contract for STRATIFIED-SAMPLE mode end-to-end through `runEval`. Sample mode
// bounds LLM cost during development by evaluating only a few questions per pack;
// the runner must apply the sampler BEFORE answering/judging (so cost really is
// bounded), report `total` (pre-sample) vs `sampled` (post-sample), and select
// deterministically so repeated runs evaluate the same questions.

import { describe, expect, it } from 'vitest';

import { runEval } from '../src/index.js';
import type { EvalQuestion } from '../src/index.js';
import { fakeArm, fakeJudge, makeQuestion } from './helpers.js';

/** Three packs: 5 + 4 + 2 = 11 questions. */
function corpus(): EvalQuestion[] {
  const out: EvalQuestion[] = [];
  for (let i = 0; i < 5; i++) out.push(makeQuestion({ id: `a${i}`, packId: 'alpha' }));
  for (let i = 0; i < 4; i++) out.push(makeQuestion({ id: `b${i}`, packId: 'beta' }));
  for (let i = 0; i < 2; i++) out.push(makeQuestion({ id: `c${i}`, packId: 'gamma' }));
  return out;
}

/** An arm that answers every question with a fixed non-empty string. */
const everyArm = (name: string, questions: EvalQuestion[]) =>
  fakeArm(name, Object.fromEntries(questions.map((q) => [q.id, 'an answer'])));

describe('runEval — stratified sample mode', () => {
  it('evaluates at most perPack × packCount questions', async () => {
    const questions = corpus();
    const wp = everyArm('with-pack', questions);
    const to = everyArm('training-only', questions);

    const report = await runEval({
      questions,
      withPack: wp,
      trainingOnly: to,
      judge: fakeJudge(),
      sample: { mode: 'stratified', perPack: 2 },
    });

    const packCount = new Set(questions.map((q) => q.packId)).size; // 3
    expect(report.sampled).toBeLessThanOrEqual(2 * packCount); // ≤ 6
    // alpha→2, beta→2, gamma→2(all it has) = 6
    expect(report.sampled).toBe(6);
  });

  it('reports `total` as the pre-sample count and `sampled` as the post-sample count', async () => {
    const questions = corpus();
    const report = await runEval({
      questions,
      withPack: everyArm('with-pack', questions),
      trainingOnly: everyArm('training-only', questions),
      judge: fakeJudge(),
      sample: { mode: 'stratified', perPack: 1 },
    });
    expect(report.total).toBe(11);
    expect(report.sampled).toBe(3); // one per pack
    expect(report.results).toHaveLength(3);
  });

  it('only the sampled questions are answered (cost truly bounded)', async () => {
    const questions = corpus();
    const wp = everyArm('with-pack', questions);
    const to = everyArm('training-only', questions);
    await runEval({
      questions,
      withPack: wp,
      trainingOnly: to,
      judge: fakeJudge(),
      sample: { mode: 'stratified', perPack: 1 },
    });
    // Each arm answered only the 3 sampled questions, not all 11.
    expect(wp.calls).toHaveLength(3);
    expect(to.calls).toHaveLength(3);
  });

  it('selects deterministically — repeated runs evaluate the same questions', async () => {
    const questions = corpus();
    const run = async () => {
      const wp = everyArm('with-pack', questions);
      await runEval({
        questions,
        withPack: wp,
        trainingOnly: everyArm('training-only', questions),
        judge: fakeJudge(),
        sample: { mode: 'stratified', perPack: 2 },
      });
      return wp.calls.map((q) => q.id);
    };
    expect(await run()).toEqual(await run());
  });

  it("evaluates every question in 'full' mode (the default)", async () => {
    const questions = corpus();
    const report = await runEval({
      questions,
      withPack: everyArm('with-pack', questions),
      trainingOnly: everyArm('training-only', questions),
      judge: fakeJudge(),
      sample: { mode: 'full' },
    });
    expect(report.total).toBe(11);
    expect(report.sampled).toBe(11);
  });
});
