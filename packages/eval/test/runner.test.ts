// packages/eval/test/runner.test.ts
//
// Contract for the orchestrator (`runEval`) plus the skill-evaluator registry and
// the path-confined question loader. Everything is injected, so the suite is
// fully offline: fake arms produce answers, a fake judge (or a deterministic
// skill evaluator) scores them, and an in-memory loader stands in for disk.
//
// What the runner must do per its API contract:
//   1. resolve questions from `questions` XOR (`loader` + `packIds`);
//   2. run BOTH arms for every question;
//   3. score each arm's answer with the question's skill evaluator, falling back
//      to the LLM judge;
//   4. aggregate per-arm metrics and the with-pack-vs-training comparison;
//   5. return an in-memory EvalReport (results in evaluated order).

import { describe, expect, it } from 'vitest';

import {
  EvalError,
  createDirQuestionLoader,
  createSkillEvaluatorRegistry,
  runEval,
} from '../src/index.js';
import type { EvalQuestion, JudgeVerdict, SkillEvaluator } from '../src/index.js';
import { fakeArm, fakeJudge, inMemoryLoader, makeQuestion, neverJudge } from './helpers.js';

const questions: EvalQuestion[] = [
  makeQuestion({
    id: 'q1',
    packId: 'demo',
    question: 'What is HNSW?',
    referenceAnswer: 'a graph index',
  }),
  makeQuestion({ id: 'q2', packId: 'demo', question: 'What is BM25?' }),
];

/** with-pack answers both; training-only only answers q2 (q1 is the pack's lift). */
const withPack = () => fakeArm('with-pack', { q1: 'a graph index', q2: 'ranking function' });
const trainingOnly = () => fakeArm('training-only', { q1: '', q2: 'ranking function' });

describe('runEval — orchestration', () => {
  it('runs both arms for every question and scores each with the judge', async () => {
    const wp = withPack();
    const to = trainingOnly();
    const judge = fakeJudge();

    await runEval({ questions, withPack: wp, trainingOnly: to, judge });

    expect(wp.calls.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(to.calls.map((q) => q.id)).toEqual(['q1', 'q2']);
    // The judge graded each arm's answer: 2 questions × 2 arms = 4 grades.
    expect(judge.inputs).toHaveLength(4);
  });

  it('returns per-arm aggregates that match the answers', async () => {
    const report = await runEval({
      questions,
      withPack: withPack(),
      trainingOnly: trainingOnly(),
      judge: fakeJudge(),
    });
    // with-pack answered both → 1.0; training-only missed q1 (empty) → 0.5.
    expect(report.arms.withPack.accuracy).toBeCloseTo(1, 12);
    expect(report.arms.trainingOnly.accuracy).toBeCloseTo(0.5, 12);
    expect(report.arms.withPack.name).toBe('with-pack');
    expect(report.arms.trainingOnly.name).toBe('training-only');
  });

  it('computes the with-pack-vs-training comparison', async () => {
    const report = await runEval({
      questions,
      withPack: withPack(),
      trainingOnly: trainingOnly(),
      judge: fakeJudge(),
    });
    // q1: with-pack correct, training-only incorrect → win; q2: both correct → tie.
    expect(report.comparison.wins).toBe(1);
    expect(report.comparison.losses).toBe(0);
    expect(report.comparison.ties).toBe(1);
    expect(report.comparison.deltaAccuracy).toBeCloseTo(0.5, 12);
    expect(report.comparison.winRate).toBeCloseTo(1, 12);
  });

  it('records per-question, per-arm answers and verdicts keyed by arm name', async () => {
    const report = await runEval({
      questions,
      withPack: withPack(),
      trainingOnly: trainingOnly(),
      judge: fakeJudge(),
    });
    expect(report.results.map((r) => r.question.id)).toEqual(['q1', 'q2']);
    const first = report.results[0]!;
    expect(first.arms['with-pack']!.answer).toBe('a graph index');
    expect(first.arms['with-pack']!.verdict.correct).toBe(true);
    expect(first.arms['training-only']!.answer).toBe('');
    expect(first.arms['training-only']!.verdict.correct).toBe(false);
  });

  it('reports total and sampled counts (equal when sampling is off)', async () => {
    const report = await runEval({
      questions,
      withPack: withPack(),
      trainingOnly: trainingOnly(),
      judge: fakeJudge(),
    });
    expect(report.total).toBe(2);
    expect(report.sampled).toBe(2);
  });
});

describe('runEval — question source', () => {
  it('loads questions via loader + packIds when `questions` is absent', async () => {
    const loader = inMemoryLoader({ demo: questions });
    const report = await runEval({
      loader,
      packIds: ['demo'],
      withPack: withPack(),
      trainingOnly: trainingOnly(),
      judge: fakeJudge(),
    });
    expect(loader.loaded).toEqual(['demo']);
    expect(report.total).toBe(2);
  });

  it('throws EvalError when neither `questions` nor `loader` is supplied', async () => {
    await expect(
      runEval({ withPack: withPack(), trainingOnly: trainingOnly(), judge: fakeJudge() }),
    ).rejects.toThrow(EvalError);
  });

  it('throws EvalError when BOTH `questions` and `loader` are supplied', async () => {
    await expect(
      runEval({
        questions,
        loader: inMemoryLoader({ demo: questions }),
        packIds: ['demo'],
        withPack: withPack(),
        trainingOnly: trainingOnly(),
        judge: fakeJudge(),
      }),
    ).rejects.toThrow(EvalError);
  });

  it('throws EvalError when `loader` is supplied without `packIds`', async () => {
    await expect(
      runEval({
        loader: inMemoryLoader({ demo: questions }),
        withPack: withPack(),
        trainingOnly: trainingOnly(),
        judge: fakeJudge(),
      }),
    ).rejects.toThrow(EvalError);
  });
});

describe('runEval — skill evaluators', () => {
  const exactMatch: SkillEvaluator = {
    name: 'exact',
    async evaluate(question: EvalQuestion, answer: string): Promise<JudgeVerdict> {
      const correct = answer === question.referenceAnswer;
      return { correct, score: correct ? 1 : 0, reasoning: 'exact-match' };
    },
  };

  it('routes a registered skill to its evaluator, bypassing the judge entirely', async () => {
    const skilled = [
      makeQuestion({ id: 's1', packId: 'p', skill: 'exact', referenceAnswer: 'Paris' }),
    ];
    // judge throws if touched — proves the evaluator fully replaced it.
    const registry = createSkillEvaluatorRegistry(neverJudge(), [exactMatch]);
    const report = await runEval({
      questions: skilled,
      withPack: fakeArm('with-pack', { s1: 'Paris' }),
      trainingOnly: fakeArm('training-only', { s1: 'London' }),
      judge: neverJudge(),
      skillEvaluators: registry,
    });
    expect(report.results[0]!.arms['with-pack']!.verdict.correct).toBe(true);
    expect(report.results[0]!.arms['training-only']!.verdict.correct).toBe(false);
  });

  it('falls back to the LLM judge for an unset/unregistered skill', async () => {
    const mixed = [makeQuestion({ id: 'm1', packId: 'p' })]; // no skill tag
    const judge = fakeJudge();
    const registry = createSkillEvaluatorRegistry(judge, [exactMatch]);
    await runEval({
      questions: mixed,
      withPack: fakeArm('with-pack', { m1: 'some answer' }),
      trainingOnly: fakeArm('training-only', { m1: 'other answer' }),
      judge,
      skillEvaluators: registry,
    });
    // Both arms' answers for the unregistered question went to the judge.
    expect(judge.inputs.map((i) => i.answer).sort()).toEqual(['other answer', 'some answer']);
  });
});

describe('createSkillEvaluatorRegistry — resolution', () => {
  it('resolves a registered skill to its evaluator', () => {
    const registry = createSkillEvaluatorRegistry(fakeJudge(), [
      { name: 'exact', evaluate: async () => ({ correct: true, score: 1, reasoning: 'x' }) },
    ]);
    expect(registry.resolve('exact').name).toBe('exact');
  });

  it('resolves an unknown or undefined skill to a judge-backed default evaluator', async () => {
    const judge = fakeJudge();
    const registry = createSkillEvaluatorRegistry(judge, []);
    const def = registry.resolve(undefined);
    await def.evaluate(
      makeQuestion({ id: 'd1', question: 'Q?', referenceAnswer: 'R' }),
      'candidate',
    );
    // The default evaluator delegates to the judge.
    expect(judge.inputs).toHaveLength(1);
    expect(judge.inputs[0]).toMatchObject({
      question: 'Q?',
      answer: 'candidate',
      referenceAnswer: 'R',
    });
  });
});

describe('createDirQuestionLoader — path confinement', () => {
  it('rejects a packId containing a parent-directory traversal', async () => {
    const loader = createDirQuestionLoader('packs');
    await expect(loader.load('../etc')).rejects.toThrow();
  });

  it('rejects an absolute packId', async () => {
    const loader = createDirQuestionLoader('packs');
    await expect(loader.load('/etc/passwd')).rejects.toThrow();
  });

  it('rejects a packId containing a NUL byte', async () => {
    const loader = createDirQuestionLoader('packs');
    await expect(loader.load('demo\u0000')).rejects.toThrow();
  });
});
