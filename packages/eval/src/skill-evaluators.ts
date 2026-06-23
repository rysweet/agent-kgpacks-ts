// @kgpacks/eval — the skill-evaluator registry.
//
// Ports the reference skill-evaluators module: a `skill → evaluator` registry
// that lets specific
// question skills be graded by a purpose-built scorer instead of the generic LLM
// judge. Questions whose `skill` is unset or unregistered fall back to a default
// evaluator that delegates to the judge (decision D6).

import type {
  EvalQuestion,
  Judge,
  JudgeVerdict,
  SkillEvaluator,
  SkillEvaluatorRegistry,
} from './types.js';

/**
 * Builds a {@link SkillEvaluatorRegistry} over the given evaluators, defaulting
 * any unmatched skill to a judge-backed evaluator. The default evaluator forwards
 * the question/answer/reference to `judge.judge`, so the registry is a drop-in
 * superset of "always use the judge".
 */
export function createSkillEvaluatorRegistry(
  judge: Judge,
  evaluators: SkillEvaluator[] = [],
): SkillEvaluatorRegistry {
  const byName = new Map<string, SkillEvaluator>();
  for (const evaluator of evaluators) {
    byName.set(evaluator.name, evaluator);
  }
  const fallback = judgeBackedEvaluator(judge);

  return {
    resolve(skill: string | undefined): SkillEvaluator {
      if (skill !== undefined) {
        const found = byName.get(skill);
        if (found) return found;
      }
      return fallback;
    },
  };
}

/** A {@link SkillEvaluator} that delegates to the LLM judge. */
function judgeBackedEvaluator(judge: Judge): SkillEvaluator {
  return {
    name: 'judge',
    async evaluate(question: EvalQuestion, answer: string): Promise<JudgeVerdict> {
      return judge.judge({
        question: question.question,
        answer,
        ...(question.referenceAnswer !== undefined
          ? { referenceAnswer: question.referenceAnswer }
          : {}),
      });
    },
  };
}
