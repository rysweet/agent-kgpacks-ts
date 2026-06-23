// @kgpacks/eval — the run orchestrator.
//
// Ports the reference runner module. `runEval`:
//   1. resolves questions from `questions` XOR (`loader` + `packIds`);
//   2. applies the optional sampler BEFORE answering (so cost is truly bounded);
//   3. for each sampled question runs BOTH arms;
//   4. scores each arm's answer with the question's skill evaluator, falling back
//      to the LLM judge;
//   5. aggregates per-arm metrics and the with-pack-vs-training comparison;
//   6. returns an in-memory `EvalReport` (results in evaluated order).
// Execution is SEQUENTIAL and in-memory only — no persistence, no CLI (Phase 1).

import { EvalError } from './errors.js';
import { aggregateArm, compareArms } from './metrics.js';
import { selectSample } from './sampling.js';
import { createSkillEvaluatorRegistry } from './skill-evaluators.js';
import type {
  EvalQuestion,
  EvalReport,
  JudgeVerdict,
  QuestionResult,
  RunEvalOptions,
  SkillEvaluatorRegistry,
} from './types.js';

/** Runs an evaluation end-to-end and returns the in-memory report. */
export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const all = await resolveQuestions(options);
  const total = all.length;

  const sampled = selectSample(all, options.sample ?? { mode: 'full' });

  const registry: SkillEvaluatorRegistry =
    options.skillEvaluators ?? createSkillEvaluatorRegistry(options.judge);

  const results: QuestionResult[] = [];
  const withPackVerdicts: JudgeVerdict[] = [];
  const trainingOnlyVerdicts: JudgeVerdict[] = [];

  for (const question of sampled) {
    const evaluator = registry.resolve(question.skill);

    const withPackAnswer = await options.withPack.answer(question);
    const withPackVerdict = await evaluator.evaluate(question, withPackAnswer.answer);

    const trainingOnlyAnswer = await options.trainingOnly.answer(question);
    const trainingOnlyVerdict = await evaluator.evaluate(question, trainingOnlyAnswer.answer);

    withPackVerdicts.push(withPackVerdict);
    trainingOnlyVerdicts.push(trainingOnlyVerdict);

    results.push({
      question,
      arms: {
        [options.withPack.name]: { answer: withPackAnswer.answer, verdict: withPackVerdict },
        [options.trainingOnly.name]: {
          answer: trainingOnlyAnswer.answer,
          verdict: trainingOnlyVerdict,
        },
      },
    });
  }

  return {
    results,
    arms: {
      withPack: aggregateArm(options.withPack.name, withPackVerdicts),
      trainingOnly: aggregateArm(options.trainingOnly.name, trainingOnlyVerdicts),
    },
    comparison: compareArms(withPackVerdicts, trainingOnlyVerdicts),
    sampled: sampled.length,
    total,
  };
}

/**
 * Resolves the question set from EXACTLY ONE source: in-memory `questions`, or a
 * `loader` + non-empty `packIds`. Supplying neither, both, or a loader without
 * packIds throws `EvalError` before any LLM call is made.
 */
async function resolveQuestions(options: RunEvalOptions): Promise<EvalQuestion[]> {
  const hasQuestions = options.questions !== undefined;
  const hasLoader = options.loader !== undefined;

  if (hasQuestions && hasLoader) {
    throw new EvalError('Provide either `questions` or `loader` (+ `packIds`), not both.');
  }
  if (!hasQuestions && !hasLoader) {
    throw new EvalError('Provide either `questions` or a `loader` (+ `packIds`).');
  }

  if (hasQuestions) {
    return options.questions!;
  }

  if (!options.packIds || options.packIds.length === 0) {
    throw new EvalError('`loader` requires a non-empty `packIds` list.');
  }

  const loaded: EvalQuestion[] = [];
  for (const packId of options.packIds) {
    loaded.push(...(await options.loader!.load(packId)));
  }
  return loaded;
}
