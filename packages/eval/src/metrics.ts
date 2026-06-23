// @kgpacks/eval — pure metric aggregation.
//
// IO-free, total, and deterministic: these turn per-question verdicts into the
// per-arm and head-to-head numbers that headline an `EvalReport`. Empty inputs
// yield zeros, never `NaN` (decision D4 / docs/packages/eval.md "Metric
// definitions").

import type { ArmReport, ComparisonReport, JudgeVerdict } from './types.js';

/** Mean of `verdict.correct` over the verdicts; `0` for an empty list. */
function accuracyOf(verdicts: JudgeVerdict[]): number {
  if (verdicts.length === 0) return 0;
  const correct = verdicts.reduce((n, v) => n + (v.correct ? 1 : 0), 0);
  return correct / verdicts.length;
}

/**
 * Computes one arm's `accuracy` (mean of `correct`) and `meanScore` (mean of
 * `score`). An empty input yields `accuracy: 0, meanScore: 0, count: 0` (never
 * `NaN`).
 */
export function aggregateArm(name: string, results: JudgeVerdict[]): ArmReport {
  const count = results.length;
  if (count === 0) {
    return { name, accuracy: 0, meanScore: 0, count: 0 };
  }
  const scoreSum = results.reduce((sum, v) => sum + v.score, 0);
  return { name, accuracy: accuracyOf(results), meanScore: scoreSum / count, count };
}

/**
 * Computes the head-to-head comparison of two index-aligned verdict lists:
 * `deltaAccuracy`, per-question `wins` / `losses` / `ties`, and
 * `winRate = wins / (wins + losses)` (which is `0` — never `NaN` — when no
 * question is decisive). The two arrays MUST be aligned by question; `runEval`
 * guarantees this.
 */
export function compareArms(
  withPack: JudgeVerdict[],
  trainingOnly: JudgeVerdict[],
): ComparisonReport {
  const deltaAccuracy = accuracyOf(withPack) - accuracyOf(trainingOnly);

  const paired = Math.min(withPack.length, trainingOnly.length);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (let i = 0; i < paired; i++) {
    const w = withPack[i]!.correct;
    const t = trainingOnly[i]!.correct;
    if (w && !t) wins++;
    else if (!w && t) losses++;
    else ties++;
  }

  const decisive = wins + losses;
  const winRate = decisive === 0 ? 0 : wins / decisive;

  return { deltaAccuracy, wins, losses, ties, winRate };
}
