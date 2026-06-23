// packages/eval/test/sampling.test.ts
//
// Contract for the deterministic stratified sampler (`sampling.ts`). The sampler
// bounds LLM cost during development by taking a few questions per pack, and it
// MUST be reproducible (stable sort, first-N, no RNG) so two runs over the same
// input evaluate the same questions and test assertions never flake.

import { describe, expect, it } from 'vitest';

import { DEFAULT_PER_PACK, EvalError, selectSample } from '../src/index.js';
import type { EvalQuestion } from '../src/index.js';

const q = (id: string, packId: string, skill?: string): EvalQuestion => ({
  id,
  question: `question ${id}`,
  packId,
  ...(skill !== undefined ? { skill } : {}),
});

/** A three-pack corpus: 4 + 3 + 1 questions. */
const corpus: EvalQuestion[] = [
  q('a1', 'alpha'),
  q('a2', 'alpha'),
  q('a3', 'alpha'),
  q('a4', 'alpha'),
  q('b1', 'beta'),
  q('b2', 'beta'),
  q('b3', 'beta'),
  q('c1', 'gamma'),
];

describe('selectSample — full mode', () => {
  it("returns the input unchanged in 'full' mode", () => {
    const out = selectSample(corpus, { mode: 'full' });
    expect(out.map((x) => x.id)).toEqual(corpus.map((x) => x.id));
  });
});

describe('selectSample — stratified mode', () => {
  it('takes at most perPack questions per pack', () => {
    const out = selectSample(corpus, { mode: 'stratified', perPack: 2 });
    const byPack = countByPack(out);
    expect(byPack.alpha).toBe(2);
    expect(byPack.beta).toBe(2);
    expect(byPack.gamma).toBe(1); // pack smaller than perPack contributes all it has
    expect(out).toHaveLength(5);
  });

  it('selects the FIRST perPack of each pack (stable, first-N — no RNG)', () => {
    const out = selectSample(corpus, { mode: 'stratified', perPack: 2 });
    const alpha = out.filter((x) => x.packId === 'alpha').map((x) => x.id);
    expect(alpha).toEqual(['a1', 'a2']);
  });

  it('is deterministic: repeated runs select exactly the same questions', () => {
    const first = selectSample(corpus, { mode: 'stratified', perPack: 2 }).map((x) => x.id);
    const second = selectSample(corpus, { mode: 'stratified', perPack: 2 }).map((x) => x.id);
    expect(second).toEqual(first);
  });

  it('bounds the sample by perPack × packCount', () => {
    const packCount = new Set(corpus.map((x) => x.packId)).size; // 3
    const perPack = 2;
    const out = selectSample(corpus, { mode: 'stratified', perPack });
    expect(out.length).toBeLessThanOrEqual(perPack * packCount);
  });

  it('defaults perPack to DEFAULT_PER_PACK when omitted', () => {
    const out = selectSample(corpus, { mode: 'stratified' });
    const byPack = countByPack(out);
    expect(byPack.alpha).toBe(Math.min(DEFAULT_PER_PACK, 4));
    expect(byPack.beta).toBe(Math.min(DEFAULT_PER_PACK, 3));
    expect(byPack.gamma).toBe(Math.min(DEFAULT_PER_PACK, 1));
  });

  it('sub-stratifies by skill within a pack when skills are present', () => {
    // One pack, two skills, two questions each. perPack=2 should not collapse a
    // whole pack onto a single skill — it samples across skills.
    const skilled: EvalQuestion[] = [
      q('s1', 'p', 'recall'),
      q('s2', 'p', 'recall'),
      q('s3', 'p', 'reason'),
      q('s4', 'p', 'reason'),
    ];
    const out = selectSample(skilled, { mode: 'stratified', perPack: 2 });
    const skills = new Set(out.map((x) => x.skill));
    expect(skills.has('recall')).toBe(true);
    expect(skills.has('reason')).toBe(true);
  });
});

describe('selectSample — validation', () => {
  it('throws EvalError for a non-positive perPack', () => {
    expect(
      grabError(() => selectSample(corpus, { mode: 'stratified', perPack: 0 })),
    ).toBeInstanceOf(EvalError);
    expect(
      grabError(() => selectSample(corpus, { mode: 'stratified', perPack: -1 })),
    ).toBeInstanceOf(EvalError);
  });

  it('throws EvalError for a non-integer perPack', () => {
    expect(
      grabError(() => selectSample(corpus, { mode: 'stratified', perPack: 1.5 })),
    ).toBeInstanceOf(EvalError);
  });
});

/** Runs `fn` and returns whatever it threw (failing the test if it did not throw). */
function grabError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

function countByPack(questions: EvalQuestion[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of questions) counts[item.packId] = (counts[item.packId] ?? 0) + 1;
  return counts;
}
