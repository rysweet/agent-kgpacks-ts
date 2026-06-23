// @kgpacks/eval — public entry point.
//
// The strict-ESM evaluation layer of the port: it measures how well the
// retrieval + synthesis pipeline answers a pack's eval questions, scoring each
// answer with an LLM judge pinned to a single model held constant across both
// arms. Ported from the reference `wikigr/packs/eval` modules — the runner,
// baselines, and skill-evaluators modules. Every external seam (judge transport,
// synthesis agent, retriever, question loader) is injectable, so unit tests run
// fully offline with the judge and agent mocked. See docs/packages/eval.md.

export { runEval } from './runner.js';
export { withPackArm, trainingOnlyArm } from './baselines.js';
export { createLlmJudge } from './judge.js';
export { createSkillEvaluatorRegistry } from './skill-evaluators.js';
export { createDirQuestionLoader, EVAL_QUESTIONS_FILENAME } from './loader.js';
export { selectSample } from './sampling.js';
export { aggregateArm, compareArms } from './metrics.js';
export { EvalError } from './errors.js';
export { DEFAULT_JUDGE_MODEL, DEFAULT_PER_PACK, JUDGE_PROMPT } from './constants.js';

export type {
  Arm,
  ArmAnswer,
  ArmReport,
  ComparisonReport,
  EvalQuestion,
  EvalReport,
  Judge,
  JudgeInput,
  JudgeVerdict,
  LlmJudgeOptions,
  QuestionLoader,
  QuestionResult,
  RunEvalOptions,
  SampleOptions,
  SkillEvaluator,
  SkillEvaluatorRegistry,
  Transport,
  Usage,
} from './types.js';
