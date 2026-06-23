// packages/eval/test/metrics.test.ts
//
// Contract for the pure, IO-free metric aggregators (`metrics.ts`). These
// functions take per-question verdicts and produce the per-arm and head-to-head
// numbers that headline an `EvalReport`. No mocks needed — the math is total and
// deterministic, and must never produce `NaN`.

import { describe, expect, it } from 'vitest';

import { aggregateArm, compareArms } from '../src/index.js';
import type { JudgeVerdict } from '../src/index.js';

const v = (correct: boolean, score: number): JudgeVerdict => ({
  correct,
  score,
  reasoning: 'x',
});

describe('aggregateArm', () => {
  it('reports the arm name verbatim and the count of verdicts', () => {
    const report = aggregateArm('with-pack', [v(true, 1), v(false, 0)]);
    expect(report.name).toBe('with-pack');
    expect(report.count).toBe(2);
  });

  it('accuracy is the mean of `correct` (fraction of true verdicts)', () => {
    // 3 of 4 correct → 0.75
    const report = aggregateArm('a', [v(true, 1), v(true, 0.9), v(false, 0.2), v(true, 0.8)]);
    expect(report.accuracy).toBeCloseTo(0.75, 12);
  });

  it('meanScore is the mean of `score` (independent of `correct`)', () => {
    const report = aggregateArm('a', [v(true, 0.4), v(false, 0.6)]);
    expect(report.meanScore).toBeCloseTo(0.5, 12);
  });

  it('an empty input yields zeros, never NaN', () => {
    const report = aggregateArm('a', []);
    expect(report.count).toBe(0);
    expect(report.accuracy).toBe(0);
    expect(report.meanScore).toBe(0);
    expect(Number.isNaN(report.accuracy)).toBe(false);
    expect(Number.isNaN(report.meanScore)).toBe(false);
  });

  it('a perfect arm scores accuracy 1', () => {
    expect(aggregateArm('a', [v(true, 1), v(true, 1)]).accuracy).toBe(1);
  });
});

describe('compareArms', () => {
  it('deltaAccuracy = withPack.accuracy − trainingOnly.accuracy (the pack lift)', () => {
    const withPack = [v(true, 1), v(true, 1), v(false, 0), v(true, 1)]; // 0.75
    const trainingOnly = [v(true, 1), v(false, 0), v(false, 0), v(false, 0)]; // 0.25
    const cmp = compareArms(withPack, trainingOnly);
    expect(cmp.deltaAccuracy).toBeCloseTo(0.5, 12);
  });

  it('deltaAccuracy can be negative when the pack regresses', () => {
    const withPack = [v(false, 0), v(false, 0)];
    const trainingOnly = [v(true, 1), v(true, 1)];
    expect(compareArms(withPack, trainingOnly).deltaAccuracy).toBeCloseTo(-1, 12);
  });

  it('classifies each aligned question as win / loss / tie', () => {
    // q1 win (T/F), q2 loss (F/T), q3 tie-correct (T/T), q4 tie-incorrect (F/F)
    const withPack = [v(true, 1), v(false, 0), v(true, 1), v(false, 0)];
    const trainingOnly = [v(false, 0), v(true, 1), v(true, 1), v(false, 0)];
    const cmp = compareArms(withPack, trainingOnly);
    expect(cmp.wins).toBe(1);
    expect(cmp.losses).toBe(1);
    expect(cmp.ties).toBe(2);
  });

  it('winRate = wins / (wins + losses), ignoring ties', () => {
    // 3 wins, 1 loss, 2 ties → 3/4 = 0.75
    const withPack = [v(true, 1), v(true, 1), v(true, 1), v(false, 0), v(true, 1), v(false, 0)];
    const trainingOnly = [
      v(false, 0),
      v(false, 0),
      v(false, 0),
      v(true, 1),
      v(true, 1),
      v(false, 0),
    ];
    const cmp = compareArms(withPack, trainingOnly);
    expect(cmp.wins).toBe(3);
    expect(cmp.losses).toBe(1);
    expect(cmp.winRate).toBeCloseTo(0.75, 12);
  });

  it('winRate is 0 (never NaN) when no question is decisive', () => {
    // Every question is a tie ⇒ wins + losses === 0.
    const withPack = [v(true, 1), v(false, 0)];
    const trainingOnly = [v(true, 1), v(false, 0)];
    const cmp = compareArms(withPack, trainingOnly);
    expect(cmp.wins).toBe(0);
    expect(cmp.losses).toBe(0);
    expect(cmp.winRate).toBe(0);
    expect(Number.isNaN(cmp.winRate)).toBe(false);
  });

  it('handles two empty arms without throwing or producing NaN', () => {
    const cmp = compareArms([], []);
    expect(cmp).toMatchObject({ deltaAccuracy: 0, wins: 0, losses: 0, ties: 0, winRate: 0 });
    expect(Number.isNaN(cmp.deltaAccuracy)).toBe(false);
  });
});
